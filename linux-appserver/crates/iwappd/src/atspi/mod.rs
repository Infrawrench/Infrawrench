//! Accessibility: the AT-SPI side of `a11yTree`.
//!
//! Toolkits export their widget trees over D-Bus to whoever owns
//! `org.a11y.atspi.Registry`. On a desktop that is `at-spi2-registryd`; on the
//! headless hosts we serve there is nobody — so this module *is* the registry.
//! It claims the name on the session bus (the same bus `launch_env::apply_a11y`
//! points `AT_SPI_BUS_ADDRESS` at), answers each application's `Embed`, and
//! remembers which connection is which process. Walking a tree is then a series
//! of ordinary method calls against the application's own objects.
//!
//! If a real registry already owns the name — the host runs an actual desktop
//! session — we read the application list from it instead of competing.
//!
//! Everything runs on one dedicated thread with its own bus connection, talked
//! to over channels: a walk is thousands of round trips, and the serve loop has
//! frames to encode. The thread answers `Embed` even mid-walk (the sideline in
//! [`dbus::Connection::call`]), because a toolkit that cannot register may
//! stall its own startup waiting.

pub mod dbus;
mod names;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use iw_proto::{A11yBounds, A11yNode};

use dbus::{Connection, DbusError, Message, MethodCall, Writer};

const REGISTRY_NAME: &str = "org.a11y.atspi.Registry";
const ROOT_PATH: &str = "/org/a11y/atspi/accessible/root";
const NULL_PATH: &str = "/org/a11y/atspi/null";
const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const BUS_NAME: &str = "org.freedesktop.DBus";
const BUS_PATH: &str = "/org/freedesktop/DBus";

/// Ceilings for one walk. The node cap is generous — a busy browser page can
/// be thousands of elements — but bounded, because the reply crosses an SSH
/// link and a runaway tree helps nobody.
const MAX_NODES: usize = 1500;
const MAX_DEPTH: usize = 60;
const MAX_TEXT: usize = 2000;
const WALK_BUDGET: Duration = Duration::from_secs(5);
const CALL_TIMEOUT: Duration = Duration::from_millis(800);

/// What the serve loop asks for.
pub struct A11yQuery {
    pub window_id: u32,
    pub request_id: u32,
    /// Pid of the Wayland client that owns the window, when the compositor
    /// can tell — how a window is matched to its AT-SPI application.
    pub pid: Option<u32>,
}

/// What comes back; mirrors [`iw_proto::ServerMessage::A11yTree`].
pub struct A11yResult {
    pub window_id: u32,
    pub request_id: u32,
    pub tree: Option<A11yNode>,
    pub message: Option<String>,
}

/// Handle held by the serve loop; the work happens on the module's thread.
pub struct A11yHandle {
    queries: mpsc::Sender<A11yQuery>,
    results: mpsc::Receiver<A11yResult>,
}

impl A11yHandle {
    /// Start the registry thread against a resolved session-bus address.
    /// `wake` interrupts the serve loop's poll when a result is ready.
    pub fn start(address: String, wake: impl Fn() + Send + 'static) -> Self {
        let (query_tx, query_rx) = mpsc::channel::<A11yQuery>();
        let (result_tx, result_rx) = mpsc::channel::<A11yResult>();
        std::thread::spawn(move || run(&address, &query_rx, &result_tx, &wake));
        Self {
            queries: query_tx,
            results: result_rx,
        }
    }

    /// False when the thread is gone, in which case no result will ever come
    /// and the caller must answer the client itself.
    pub fn request(&self, query: A11yQuery) -> bool {
        self.queries.send(query).is_ok()
    }

    pub fn try_results(&self) -> Vec<A11yResult> {
        self.results.try_iter().collect()
    }
}

fn run(
    address: &str,
    queries: &mpsc::Receiver<A11yQuery>,
    results: &mpsc::Sender<A11yResult>,
    wake: &(impl Fn() + Send + 'static),
) {
    let mut service = match Service::connect(address) {
        Ok(service) => Some(service),
        Err(err) => {
            eprintln!("iwappd: a11y: registry unavailable ({err})");
            None
        }
    };
    loop {
        match queries.recv_timeout(Duration::from_millis(25)) {
            Ok(query) => {
                if service.is_none() {
                    // A bus that was down at startup may be up now.
                    service = Service::connect(address).ok();
                }
                let (tree, message) = match &mut service {
                    Some(live) => {
                        let outcome = live.walk(query.pid);
                        if live.dead {
                            service = None;
                        }
                        outcome
                    }
                    None => (
                        None,
                        Some("could not reach the session bus for AT-SPI".into()),
                    ),
                };
                let sent = results.send(A11yResult {
                    window_id: query.window_id,
                    request_id: query.request_id,
                    tree,
                    message,
                });
                if sent.is_err() {
                    return;
                }
                wake();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(live) = &mut service {
                    if live.poll().is_err() {
                        eprintln!("iwappd: a11y: session bus connection lost");
                        service = None;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// An application that registered itself (or that the real registry lists).
#[derive(Debug, Clone)]
struct App {
    name: String,
    path: String,
    pid: Option<u32>,
}

struct Service {
    conn: Connection,
    /// We hold `org.a11y.atspi.Registry`; applications embed with us.
    owns_registry: bool,
    apps: Vec<App>,
    /// The connection failed mid-walk; the owner should drop us.
    dead: bool,
}

impl Service {
    fn connect(address: &str) -> Result<Self, DbusError> {
        let mut conn = Connection::connect(address)?;
        let deadline = Instant::now() + Duration::from_secs(5);

        // DO_NOT_QUEUE (4): either we are the registry or somebody real is.
        let mut body = Writer::default();
        body.string(REGISTRY_NAME);
        body.u32(4);
        let reply = conn.call(
            &MethodCall {
                destination: BUS_NAME,
                path: BUS_PATH,
                interface: BUS_NAME,
                member: "RequestName",
                signature: "su",
                body: &body.buf,
            },
            deadline,
            &mut |_| {},
        )?;
        let owns_registry = matches!(reply.reader().u32()?, 1 | 4);

        // Told when an application's connection drops, so a dead entry does
        // not linger to time a walk out. The bus itself answers matches.
        let mut body = Writer::default();
        body.string(
            "type='signal',sender='org.freedesktop.DBus',\
             interface='org.freedesktop.DBus',member='NameOwnerChanged'",
        );
        conn.call(
            &MethodCall {
                destination: BUS_NAME,
                path: BUS_PATH,
                interface: BUS_NAME,
                member: "AddMatch",
                signature: "s",
                body: &body.buf,
            },
            deadline,
            &mut |_| {},
        )?;

        Ok(Self {
            conn,
            owns_registry,
            apps: Vec::new(),
            dead: false,
        })
    }

    /// Drain whatever the bus has for us — embeds, signals — without blocking.
    fn poll(&mut self) -> Result<(), DbusError> {
        loop {
            match self.conn.read_message(Duration::from_millis(1)) {
                Ok(Some(message)) => self.handle_incoming(&message),
                Ok(None) => return Ok(()),
                Err(err) => return Err(err),
            }
        }
    }

    fn handle_incoming(&mut self, message: &Message) {
        match message.kind {
            dbus::TYPE_METHOD_CALL => self.handle_call(message),
            dbus::TYPE_SIGNAL
                if message.member.as_deref() == Some("NameOwnerChanged")
                    && message.sender.as_deref() == Some(BUS_NAME) =>
            {
                let mut r = message.reader();
                if let (Ok(name), Ok(_old), Ok(new)) = (r.string(), r.string(), r.string())
                    && new.is_empty()
                {
                    self.apps.retain(|app| app.name != name);
                }
            }
            _ => {}
        }
    }

    fn handle_call(&mut self, message: &Message) {
        let member = message.member.as_deref().unwrap_or("");
        let outcome = match member {
            // The application announces itself: record who it is, tell it who
            // its parent is. This call is the entire registration protocol.
            "Embed" => {
                let plug = message.reader().name_and_path();
                let name = message
                    .sender
                    .clone()
                    .or_else(|| plug.as_ref().ok().map(|(name, _)| name.clone()));
                let path = plug
                    .map(|(_, path)| path)
                    .unwrap_or_else(|_| ROOT_PATH.to_owned());
                if let Some(name) = name {
                    self.apps.retain(|app| app.name != name);
                    self.apps.push(App {
                        name,
                        path,
                        pid: None,
                    });
                }
                let mut body = Writer::default();
                body.name_and_path(REGISTRY_NAME, ROOT_PATH);
                self.reply(message, "(so)", &body.buf)
            }
            "Unembed" => {
                if let Ok((name, _)) = message.reader().name_and_path() {
                    self.apps.retain(|app| app.name != name);
                }
                self.reply(message, "", &[])
            }
            "Ping" => self.reply(message, "", &[]),
            // atk-bridge asks which events anyone listens for; none, truthfully.
            "GetRegisteredEvents" => {
                let mut body = Writer::default();
                body.u32(0);
                body.align(8);
                self.reply(message, "a(ss)", &body.buf)
            }
            _ => self.reply_error(
                message,
                "org.freedesktop.DBus.Error.UnknownMethod",
                &format!("iwappd's registry does not implement {member}"),
            ),
        };
        if let Err(err) = outcome {
            eprintln!("iwappd: a11y: reply failed ({err})");
            self.dead = true;
        }
    }

    fn reply(&mut self, to: &Message, signature: &str, body: &[u8]) -> Result<(), DbusError> {
        if to.flags & dbus::FLAG_NO_REPLY != 0 {
            return Ok(());
        }
        let Some(destination) = to.sender.as_deref() else {
            return Ok(());
        };
        let serial = self.conn.take_serial();
        let bytes = dbus::encode_method_return(serial, to.serial, destination, signature, body);
        self.conn.send_raw(&bytes)
    }

    fn reply_error(&mut self, to: &Message, name: &str, text: &str) -> Result<(), DbusError> {
        if to.flags & dbus::FLAG_NO_REPLY != 0 {
            return Ok(());
        }
        let Some(destination) = to.sender.as_deref() else {
            return Ok(());
        };
        let serial = self.conn.take_serial();
        let bytes = dbus::encode_error(serial, to.serial, destination, name, text);
        self.conn.send_raw(&bytes)
    }

    /// A method call that keeps serving incoming traffic while it waits, then
    /// processes what arrived. The two-step exists because the sideline cannot
    /// borrow `self` while the connection is borrowed for the call.
    fn call(&mut self, call: &MethodCall<'_>, deadline: Instant) -> Result<Message, DbusError> {
        let mut arrived: Vec<Message> = Vec::new();
        let result = self
            .conn
            .call(call, deadline, &mut |m| arrived.push(m.clone()));
        for message in arrived {
            self.handle_incoming(&message);
        }
        if let Err(DbusError::Io(_)) = &result {
            self.dead = true;
        }
        result
    }

    fn call_deadline(&self, walk_deadline: Instant) -> Instant {
        (Instant::now() + CALL_TIMEOUT).min(walk_deadline)
    }

    /// Ask the bus which process is behind a connection name.
    fn pid_of(&mut self, name: &str, deadline: Instant) -> Option<u32> {
        let mut body = Writer::default();
        body.string(name);
        let reply = self
            .call(
                &MethodCall {
                    destination: BUS_NAME,
                    path: BUS_PATH,
                    interface: BUS_NAME,
                    member: "GetConnectionUnixProcessID",
                    signature: "s",
                    body: &body.buf,
                },
                self.call_deadline(deadline),
            )
            .ok()?;
        reply.reader().u32().ok()
    }

    /// The registered applications, from our own table or the real registry.
    fn roots(&mut self, deadline: Instant) -> Result<Vec<App>, DbusError> {
        if self.owns_registry {
            self.poll()?;
            for index in 0..self.apps.len() {
                if self.apps[index].pid.is_none() {
                    let name = self.apps[index].name.clone();
                    self.apps[index].pid = self.pid_of(&name, deadline);
                }
            }
            return Ok(self.apps.clone());
        }
        let reply = self.call(
            &MethodCall {
                destination: REGISTRY_NAME,
                path: ROOT_PATH,
                interface: ACCESSIBLE,
                member: "GetChildren",
                signature: "",
                body: &[],
            },
            self.call_deadline(deadline),
        )?;
        let mut apps = Vec::new();
        let mut r = reply.reader();
        let end = r.enter_array(8)?;
        while r.pos < end {
            let (name, path) = r.name_and_path()?;
            let pid = self.pid_of(&name, deadline);
            apps.push(App { name, path, pid });
        }
        Ok(apps)
    }

    /// Walk one application's tree — the one whose process owns the window
    /// when that can be told, otherwise the only (or first) one registered.
    fn walk(&mut self, pid: Option<u32>) -> (Option<A11yNode>, Option<String>) {
        let deadline = Instant::now() + WALK_BUDGET;
        let apps = match self.roots(deadline) {
            Ok(apps) => apps,
            Err(err) => return (None, Some(format!("could not list applications: {err}"))),
        };
        if apps.is_empty() {
            return (
                None,
                Some(
                    "no application has registered an accessibility tree yet — it may still be \
                     starting, or its toolkit has no AT-SPI support"
                        .into(),
                ),
            );
        }
        let mut caveat: Option<String> = None;
        let app = match pid.and_then(|pid| apps.iter().find(|app| app.pid == Some(pid))) {
            Some(app) => app.clone(),
            None => {
                if apps.len() > 1 {
                    caveat = Some(format!(
                        "window could not be matched to a process; walking the first of {} \
                         registered applications",
                        apps.len()
                    ));
                }
                apps[0].clone()
            }
        };

        let mut walker = Walker {
            service: self,
            deadline,
            nodes: 0,
            truncated: false,
        };
        match walker.node(&app.name, &app.path, 0) {
            Some(tree) => {
                let truncated = walker.truncated;
                let message = if truncated {
                    Some(match caveat {
                        Some(caveat) => format!("{caveat}; tree truncated"),
                        None => format!("tree truncated at {MAX_NODES} nodes"),
                    })
                } else {
                    caveat
                };
                (Some(tree), message)
            }
            None => (
                None,
                Some(
                    "the application did not answer AT-SPI calls — its toolkit may not expose \
                     an accessibility tree"
                        .into(),
                ),
            ),
        }
    }
}

struct Walker<'a> {
    service: &'a mut Service,
    deadline: Instant,
    nodes: usize,
    truncated: bool,
}

impl Walker<'_> {
    fn method(
        &mut self,
        dest: &str,
        path: &str,
        interface: &str,
        member: &str,
        signature: &str,
        body: &[u8],
    ) -> Result<Message, DbusError> {
        let deadline = self.service.call_deadline(self.deadline);
        self.service.call(
            &MethodCall {
                destination: dest,
                path,
                interface,
                member,
                signature,
                body,
            },
            deadline,
        )
    }

    /// `org.freedesktop.DBus.Properties.Get`, unwrapped from its variant.
    fn property(&mut self, dest: &str, path: &str, interface: &str, name: &str) -> Option<Message> {
        let mut body = Writer::default();
        body.string(interface);
        body.string(name);
        self.method(dest, path, PROPERTIES, "Get", "ss", &body.buf)
            .ok()
    }

    fn string_property(
        &mut self,
        dest: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> Option<String> {
        let reply = self.property(dest, path, interface, name)?;
        let mut r = reply.reader();
        let signature = r.signature().ok()?;
        if signature != "s" {
            return None;
        }
        r.string().ok().filter(|text| !text.is_empty())
    }

    fn number_property(
        &mut self,
        dest: &str,
        path: &str,
        interface: &str,
        name: &str,
    ) -> Option<f64> {
        let reply = self.property(dest, path, interface, name)?;
        let mut r = reply.reader();
        match r.signature().ok()?.as_str() {
            "d" => r.f64().ok(),
            "i" => r.i32().ok().map(f64::from),
            "u" => r.u32().ok().map(f64::from),
            _ => None,
        }
    }

    fn node(&mut self, dest: &str, path: &str, depth: usize) -> Option<A11yNode> {
        if self.nodes >= MAX_NODES || depth >= MAX_DEPTH || Instant::now() >= self.deadline {
            self.truncated = true;
            return None;
        }
        self.nodes += 1;

        // The role is the litmus test: an object that cannot answer it is
        // gone (or the toolkit is not really speaking AT-SPI), so the node —
        // and for the root, the walk — is abandoned rather than fabricated.
        let role_reply = self
            .method(dest, path, ACCESSIBLE, "GetRole", "", &[])
            .ok()?;
        let role = names::role_name(role_reply.reader().u32().ok()?);

        let interfaces: Vec<String> = self
            .method(dest, path, ACCESSIBLE, "GetInterfaces", "", &[])
            .ok()
            .and_then(|reply| {
                let mut r = reply.reader();
                let end = r.enter_array(4).ok()?;
                let mut list = Vec::new();
                while r.pos < end {
                    list.push(r.string().ok()?);
                }
                Some(list)
            })
            .unwrap_or_default();
        let has = |suffix: &str| interfaces.iter().any(|i| i.ends_with(suffix));

        let name = self.string_property(dest, path, ACCESSIBLE, "Name");
        let description = self.string_property(dest, path, ACCESSIBLE, "Description");

        let states = self
            .method(dest, path, ACCESSIBLE, "GetState", "", &[])
            .ok()
            .and_then(|reply| {
                let mut r = reply.reader();
                let end = r.enter_array(4).ok()?;
                let low = if r.pos < end { r.u32().ok()? } else { 0 };
                let high = if r.pos < end { r.u32().ok()? } else { 0 };
                Some(names::state_names(low, high))
            })
            .unwrap_or_default();
        if states.iter().any(|state| state == "defunct") {
            return None;
        }

        let bounds = if has(".Component") {
            let mut body = Writer::default();
            // ATSPI_COORD_TYPE_WINDOW: the same window-local logical pixels
            // pointer input uses at scale 1.
            body.u32(1);
            self.method(
                dest,
                path,
                "org.a11y.atspi.Component",
                "GetExtents",
                "u",
                &body.buf,
            )
            .ok()
            .and_then(|reply| {
                let mut r = reply.reader();
                r.enter_struct().ok()?;
                Some(A11yBounds {
                    x: r.i32().ok()?,
                    y: r.i32().ok()?,
                    width: r.i32().ok()?,
                    height: r.i32().ok()?,
                })
            })
        } else {
            None
        };

        let text = if has(".Text") {
            let mut body = Writer::default();
            body.i32(0);
            body.i32(-1);
            self.method(
                dest,
                path,
                "org.a11y.atspi.Text",
                "GetText",
                "ii",
                &body.buf,
            )
            .ok()
            .and_then(|reply| reply.reader().string().ok())
            .map(|mut text| {
                if text.len() > MAX_TEXT {
                    let mut cut = MAX_TEXT;
                    while !text.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    text.truncate(cut);
                }
                text
            })
            .filter(|text| !text.is_empty() && Some(text) != name.as_ref())
        } else {
            None
        };

        let value = if has(".Value") {
            self.number_property(dest, path, "org.a11y.atspi.Value", "CurrentValue")
        } else {
            None
        };

        let actions = if has(".Action") {
            self.method(dest, path, "org.a11y.atspi.Action", "GetActions", "", &[])
                .ok()
                .and_then(|reply| {
                    let mut r = reply.reader();
                    let end = r.enter_array(8).ok()?;
                    let mut list = Vec::new();
                    while r.pos < end {
                        r.enter_struct().ok()?;
                        let action = r.string().ok()?;
                        r.string().ok()?;
                        r.string().ok()?;
                        if !action.is_empty() {
                            list.push(action);
                        }
                    }
                    Some(list)
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let mut children = Vec::new();
        if let Ok(reply) = self.method(dest, path, ACCESSIBLE, "GetChildren", "", &[]) {
            let mut refs = Vec::new();
            let mut r = reply.reader();
            if let Ok(end) = r.enter_array(8) {
                while r.pos < end {
                    let Ok((child_dest, child_path)) = r.name_and_path() else {
                        break;
                    };
                    refs.push((child_dest, child_path));
                }
            }
            for (child_dest, child_path) in refs {
                if child_path == NULL_PATH || child_dest.is_empty() {
                    continue;
                }
                if let Some(child) = self.node(&child_dest, &child_path, depth + 1) {
                    children.push(child);
                }
                if self.truncated {
                    break;
                }
            }
        }

        Some(A11yNode {
            role,
            name,
            description,
            text,
            value,
            states,
            bounds,
            actions,
            children,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};

    /// A real session bus for the duration of a test, killed on drop.
    struct TestBus {
        daemon: Child,
        address: String,
    }

    impl TestBus {
        fn start() -> Option<Self> {
            let mut daemon = Command::new("dbus-daemon")
                .args(["--session", "--print-address", "--nofork"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .ok()?;
            let stdout = daemon.stdout.take()?;
            let mut address = String::new();
            BufReader::new(stdout).read_line(&mut address).ok()?;
            let address = address.trim().to_owned();
            if address.is_empty() {
                let _ = daemon.kill();
                return None;
            }
            Some(Self { daemon, address })
        }
    }

    impl Drop for TestBus {
        fn drop(&mut self) {
            let _ = self.daemon.kill();
            let _ = self.daemon.wait();
        }
    }

    /// Serve a two-node fake application — a frame holding one push button —
    /// answering with the same marshalling code the walker reads with.
    fn serve_fake_app(mut conn: Connection, unique: String, stop: mpsc::Receiver<()>) {
        let array = |elem_align: usize, fill: &dyn Fn(&mut Writer)| -> Vec<u8> {
            let mut w = Writer::default();
            w.u32(0);
            w.align(elem_align);
            let start = w.buf.len();
            fill(&mut w);
            let len = (w.buf.len() - start) as u32;
            w.buf[0..4].copy_from_slice(&len.to_le_bytes());
            w.buf
        };

        loop {
            if stop.try_recv() != Err(mpsc::TryRecvError::Empty) {
                return;
            }
            let message = match conn.read_message(Duration::from_millis(20)) {
                Ok(Some(message)) => message,
                Ok(None) => continue,
                Err(_) => return,
            };
            if message.kind != dbus::TYPE_METHOD_CALL {
                continue;
            }
            let path = message.path.as_deref().unwrap_or("");
            let member = message.member.as_deref().unwrap_or("");
            let (signature, body): (&str, Vec<u8>) = match member {
                "GetRole" => {
                    let mut w = Writer::default();
                    w.u32(if path == "/root" { 23 } else { 43 });
                    ("u", w.buf)
                }
                "GetInterfaces" => {
                    let interfaces: &[&str] = if path == "/root" {
                        &["org.a11y.atspi.Accessible"]
                    } else {
                        &[
                            "org.a11y.atspi.Accessible",
                            "org.a11y.atspi.Component",
                            "org.a11y.atspi.Action",
                        ]
                    };
                    (
                        "as",
                        array(4, &|w| {
                            for interface in interfaces {
                                w.string(interface);
                            }
                        }),
                    )
                }
                "Get" => {
                    let mut r = message.reader();
                    let _interface = r.string().unwrap_or_default();
                    let property = r.string().unwrap_or_default();
                    let mut w = Writer::default();
                    w.signature("s");
                    let value = match (path, property.as_str()) {
                        ("/root", "Name") => "Calc",
                        (_, "Name") => "=",
                        _ => "",
                    };
                    w.string(value);
                    ("v", w.buf)
                }
                "GetState" => (
                    "au",
                    array(4, &|w| {
                        w.u32((1 << 25) | (1 << 30));
                        w.u32(0);
                    }),
                ),
                "GetChildren" => {
                    if path == "/root" {
                        let unique = unique.clone();
                        ("a(so)", array(8, &|w| w.name_and_path(&unique, "/btn")))
                    } else {
                        ("a(so)", array(8, &|_| {}))
                    }
                }
                "GetExtents" => {
                    let mut w = Writer::default();
                    w.align(8);
                    w.i32(10);
                    w.i32(20);
                    w.i32(30);
                    w.i32(40);
                    ("(iiii)", w.buf)
                }
                "GetActions" => (
                    "a(sss)",
                    array(8, &|w| {
                        w.align(8);
                        w.string("click");
                        w.string("press the button");
                        w.string("");
                    }),
                ),
                _ => {
                    let serial = conn.take_serial();
                    let bytes = dbus::encode_error(
                        serial,
                        message.serial,
                        message.sender.as_deref().unwrap_or(""),
                        "org.freedesktop.DBus.Error.UnknownMethod",
                        member,
                    );
                    let _ = conn.send_raw(&bytes);
                    continue;
                }
            };
            let serial = conn.take_serial();
            let bytes = dbus::encode_method_return(
                serial,
                message.serial,
                message.sender.as_deref().unwrap_or(""),
                signature,
                &body,
            );
            let _ = conn.send_raw(&bytes);
        }
    }

    #[test]
    fn the_registry_walks_a_real_bus_end_to_end() {
        let Some(bus) = TestBus::start() else {
            eprintln!("skipping: no dbus-daemon on this machine");
            return;
        };

        let mut service = Service::connect(&bus.address).expect("connect to test bus");
        assert!(service.owns_registry, "nobody else owns the registry name");

        // Before anything registers, the walk says so rather than guessing.
        let (tree, message) = service.walk(None);
        assert!(tree.is_none());
        assert!(message.unwrap().contains("no application"));

        // A fake application embeds itself, exactly as atk-bridge would.
        let mut app = Connection::connect(&bus.address).expect("app connect");
        let app_unique = app.unique_name.clone();
        let mut body = Writer::default();
        body.name_and_path(&app_unique, "/root");
        let embed_serial = app
            .send_call(&MethodCall {
                destination: REGISTRY_NAME,
                path: ROOT_PATH,
                interface: "org.a11y.atspi.Socket",
                member: "Embed",
                signature: "(so)",
                body: &body.buf,
            })
            .expect("send embed");

        // Let the registry see it and answer.
        let deadline = Instant::now() + Duration::from_secs(5);
        while service.apps.is_empty() && Instant::now() < deadline {
            service.poll().expect("poll");
        }
        assert_eq!(service.apps.len(), 1);

        // The app got its reply: the registry named itself as the parent.
        let reply = loop {
            match app
                .read_message(Duration::from_millis(50))
                .expect("embed reply")
            {
                Some(message) if message.reply_serial == Some(embed_serial) => break message,
                Some(_) => continue,
                None => assert!(Instant::now() < deadline, "no embed reply"),
            }
        };
        let (parent, parent_path) = reply.reader().name_and_path().expect("(so) reply");
        assert_eq!(parent, REGISTRY_NAME);
        assert_eq!(parent_path, ROOT_PATH);

        // Serve the fake tree from its own thread — the walker's calls need
        // answering while this thread drives the walk.
        let (stop_tx, stop_rx) = mpsc::channel();
        let server = std::thread::spawn(move || serve_fake_app(app, app_unique, stop_rx));

        let (tree, message) = service.walk(None);
        assert_eq!(message, None);
        let tree = tree.expect("a tree");
        assert_eq!(tree.role, "frame");
        assert_eq!(tree.name.as_deref(), Some("Calc"));
        assert_eq!(
            tree.states,
            vec!["showing".to_string(), "visible".to_string()]
        );
        assert_eq!(tree.children.len(), 1);
        let button = &tree.children[0];
        assert_eq!(button.role, "push button");
        assert_eq!(button.name.as_deref(), Some("="));
        assert_eq!(
            button.bounds,
            Some(iw_proto::A11yBounds {
                x: 10,
                y: 20,
                width: 30,
                height: 40
            })
        );
        assert_eq!(button.actions, vec!["click".to_string()]);

        let _ = stop_tx.send(());
        server.join().expect("fake app thread");
    }
}
