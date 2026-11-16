//! The sandbox service from the runner's side, started per connection by
//! `systemd-socket-activate` as systemd starts it (`Accept=yes`): what it
//! refuses, before any Sentry is involved. Skipped without
//! `systemd-socket-activate` (`IWCI_REQUIRE_FIXTURES` makes that fail).
#![cfg(target_os = "linux")]

use std::fs::File;
use std::os::fd::{AsRawFd, RawFd};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use iwci_sandbox_spawn::boot::Boot;
use iwci_sandbox_spawn::client;
use iwci_sandbox_spawn::service::{NAME, PROTOCOL};
use iwci_sandbox_spawn::wire;

struct Service {
    child: Child,
    dir: PathBuf,
    socket: PathBuf,
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The service, answering connections at a socket of its own, for peers
/// with uid `peer`.
fn service(peer: u32) -> Option<Service> {
    let found = Command::new("systemd-socket-activate")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !found {
        assert!(
            std::env::var_os("IWCI_REQUIRE_FIXTURES").is_none(),
            "no systemd-socket-activate"
        );
        eprintln!("skipping: no systemd-socket-activate");
        return None;
    }
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "iwci-service-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("s");
    let child = Command::new("systemd-socket-activate")
        .arg("--seqpacket")
        .arg("--accept")
        .arg(format!("--listen={}", socket.display()))
        .arg(env!("CARGO_BIN_EXE_iwci-sandbox-spawn"))
        .args([
            "serve",
            "--peer",
            &peer.to_string(),
            "--sandbox-user",
            "nobody",
        ])
        .spawn()
        .unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !socket.exists() {
        assert!(Instant::now() < until, "the socket never appeared");
        std::thread::sleep(Duration::from_millis(20));
    }
    Some(Service { child, dir, socket })
}

fn me() -> u32 {
    // SAFETY: a plain query.
    unsafe { libc::geteuid() }
}

fn boot() -> Boot {
    Boot {
        id: "iwci-test".into(),
        state_dir: "/tmp/iwci-test-state".into(),
        platform: "systrap".into(),
        network: false,
        mounts: 1,
        cpus: 1,
        memory: 1 << 28,
        flags: Vec::new(),
    }
}

/// `n` descriptors of `/dev/null`, and their numbers.
fn nulls(n: usize) -> (Vec<File>, Vec<RawFd>) {
    let files: Vec<File> = (0..n).map(|_| File::open("/dev/null").unwrap()).collect();
    let raw = files.iter().map(|f| f.as_raw_fd()).collect();
    (files, raw)
}

/// Sends `text` (and `fds`) as a request: the service's answer.
fn raw(socket: &Path, text: &str, fds: &[RawFd]) -> String {
    // SAFETY: a plain socket call.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    assert!(fd >= 0);
    // SAFETY: a zeroed sockaddr_un is valid.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as _;
    for (d, s) in addr
        .sun_path
        .iter_mut()
        .zip(socket.as_os_str().as_encoded_bytes())
    {
        *d = *s as _;
    }
    // SAFETY: a valid address.
    let r = unsafe {
        libc::connect(
            fd,
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    assert_eq!(r, 0, "{}", std::io::Error::last_os_error());
    wire::send(fd, text.as_bytes(), fds).unwrap();
    let answer = wire::recv(fd, 0)
        .unwrap()
        .map(|(b, _)| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    // SAFETY: ours, closed once.
    unsafe { libc::close(fd) };
    answer
}

#[test]
fn the_service_answers_its_peer_only() {
    let Some(ours) = service(me()) else { return };
    assert_eq!(client::protocol(&ours.socket).unwrap(), PROTOCOL);
    let Some(theirs) = service(me() + 4242) else {
        return;
    };
    let e = client::protocol(&theirs.socket).unwrap_err().to_string();
    assert!(e.contains("peer uid"), "{e}");
    let (_files, fds) = nulls(boot().descriptors());
    let e = client::start(&theirs.socket, &boot(), None, &fds, None)
        .unwrap_err()
        .to_string();
    assert!(e.contains("peer uid"), "{e}");
}

#[test]
fn a_request_that_is_not_the_runners_is_refused() {
    let Some(s) = service(me()) else { return };
    let b = boot();
    let (_files, fds) = nulls(b.descriptors());
    let request = |extra: &[&str], replaced: Option<&str>| {
        let mut text = format!("{NAME} {PROTOCOL}\n");
        for v in b.to_args() {
            if replaced.is_some_and(|k| v.starts_with(&format!("{k}="))) {
                continue;
            }
            text.push_str(&v);
            text.push('\n');
        }
        for e in extra {
            text.push_str(e);
            text.push('\n');
        }
        text
    };
    let refused = |answer: String, why: &str| {
        assert!(
            answer.starts_with("error ") && answer.contains(why),
            "{answer:?}, wanted {why:?}"
        );
    };
    // A command line, an environment or anything else that is not one of
    // the values: refused, whatever it is.
    let argv = request(&["argv=/bin/sh -c id"], None);
    refused(raw(&s.socket, &argv, &fds), "unknown argv");
    let env = request(&["env=LD_PRELOAD=/x.so"], None);
    refused(raw(&s.socket, &env, &fds), "unknown env");
    let words = request(&["/bin/sh -c id"], None);
    refused(raw(&s.socket, &words, &fds), "not key=value");
    // Values the runner would not give.
    let id = request(&["id=a b"], Some("id"));
    refused(raw(&s.socket, &id, &fds), "id");
    let root = request(&["root=/a/../b"], Some("root"));
    refused(raw(&s.socket, &root, &fds), "state directory");
    let platform = request(&["platform=ptrace"], Some("platform"));
    refused(raw(&s.socket, &platform, &fds), "platform");
    // Another protocol, and the wrong number of descriptors.
    refused(
        raw(&s.socket, "iwci-sandbox-spawn 1\nid=x\n", &fds),
        "protocol",
    );
    refused(
        raw(&s.socket, &request(&[], None), &fds[1..]),
        "descriptors",
    );
    // A cgroup that is not one: a plain directory.
    let tmp = File::open(std::env::temp_dir()).unwrap();
    let mut with_cgroup = fds.clone();
    with_cgroup.push(tmp.as_raw_fd());
    let cgroup = request(&["cgroup=1"], None);
    refused(raw(&s.socket, &cgroup, &with_cgroup), "cgroup");
    // Another Sentry or a flag: only from root, and then only the pinned
    // release.
    // A file, not a link: this test.
    let other = format!("sentry={}", std::env::current_exe().unwrap().display());
    let sentry = raw(&s.socket, &request(&[&other], None), &fds);
    let flag = raw(&s.socket, &request(&["flag=--debug"], None), &fds);
    if me() == 0 {
        refused(sentry, "not the pinned gVisor release");
    } else {
        refused(sentry, "only root");
        refused(flag, "only root");
    }
}

/// A peer that connects and says nothing does not hold an instance: it is
/// answered and let go after the request timeout.
#[test]
fn a_silent_peer_is_let_go() {
    let Some(s) = service(me()) else { return };
    // SAFETY: a plain socket call.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    assert!(fd >= 0);
    // SAFETY: a zeroed sockaddr_un is valid.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    addr.sun_family = libc::AF_UNIX as _;
    for (d, c) in addr
        .sun_path
        .iter_mut()
        .zip(s.socket.as_os_str().as_encoded_bytes())
    {
        *d = *c as _;
    }
    // SAFETY: a valid address.
    let r = unsafe {
        libc::connect(
            fd,
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    assert_eq!(r, 0);
    let started = Instant::now();
    let answer = wire::recv(fd, 0)
        .unwrap()
        .map(|(b, _)| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default();
    let waited = started.elapsed();
    // SAFETY: ours, closed once.
    unsafe { libc::close(fd) };
    assert!(answer.starts_with("error "), "{answer:?}");
    assert!(
        waited >= Duration::from_secs(9) && waited < Duration::from_secs(20),
        "let go after {waited:?}"
    );
}
