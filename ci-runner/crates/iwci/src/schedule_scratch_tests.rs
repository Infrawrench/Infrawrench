//! `/tmp/workflow` across two runners, without a scheduler.

use super::*;
use std::sync::atomic::AtomicUsize;

/// The scratch objects of a run, in memory.
#[derive(Default)]
struct Objects {
    stored: Mutex<HashMap<(String, String), Vec<u8>>>,
    layers: Mutex<HashMap<String, u64>>,
    /// Reads that fail before one works.
    failing: AtomicUsize,
    /// Reads made, by object name.
    read: Mutex<Vec<String>>,
}

/// One runner's side of [`Objects`]. Only the scratch half of [`Split`]
/// is used here.
struct Side {
    objects: Arc<Objects>,
    runner: &'static str,
    helper: bool,
}

impl Split for Side {
    fn runner(&self) -> &str {
        self.runner
    }
    fn helper(&self) -> bool {
        self.helper
    }
    fn claim(&self, _: &str) -> Result<Claim, String> {
        unreachable!()
    }
    fn holder(&self, _: &str) -> Result<Option<String>, String> {
        unreachable!()
    }
    fn release(&self, _: &str) -> Result<(), String> {
        unreachable!()
    }
    fn hand_back(&self, _: &str) -> Result<(), String> {
        unreachable!()
    }
    fn finish(&self, _: &str, _: &[u8]) -> Result<(), String> {
        unreachable!()
    }
    fn done(&self, _: &str) -> Result<Option<Vec<u8>>, String> {
        unreachable!()
    }
    fn keep(&self, _: &str, _: &[Entry]) -> Result<(), String> {
        unreachable!()
    }
    fn kept(&self, _: &str, _: &str, _: u64) -> Result<Option<Vec<Entry>>, String> {
        unreachable!()
    }
    fn ask(&self) {}
    fn end(&self) {}
    fn seen(&self) -> Result<Seen, String> {
        Ok(Seen {
            scratch: self.objects.layers.lock().unwrap().clone(),
            ..Seen::default()
        })
    }
    fn put_scratch(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        assert!(object_name(name), "{name}");
        self.objects
            .stored
            .lock()
            .unwrap()
            .insert((self.runner.into(), name.into()), bytes.to_vec());
        Ok(())
    }
    fn get_scratch(&self, runner: &str, name: &str) -> Result<Option<Vec<u8>>, String> {
        self.objects.read.lock().unwrap().push(name.into());
        if self
            .objects
            .failing
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err("the store did not answer".into());
        }
        let stored = self.objects.stored.lock().unwrap();
        Ok(stored.get(&(runner.to_string(), name.to_string())).cloned())
    }
    fn scratch_layer(&self, layer: u64) -> Result<(), String> {
        self.objects
            .layers
            .lock()
            .unwrap()
            .insert(self.runner.into(), layer);
        Ok(())
    }
}

const CAP: u64 = 64 << 20;

fn scratch() -> Scratch {
    Scratch::new(iwci_vfs::SnapshotBuilder::new().freeze().fork(), true)
}

fn pair() -> (Arc<Objects>, Side, Side) {
    let objects = Arc::new(Objects::default());
    let one = Side {
        objects: objects.clone(),
        runner: "ci-1",
        helper: false,
    };
    let two = Side {
        objects: objects.clone(),
        runner: "ci-2",
        helper: true,
    };
    (objects, one, two)
}

fn no_secrets() -> Masker {
    Masker::new(std::iter::empty::<&String>())
}

fn view(scratch: &Scratch) -> ScratchView {
    scratch.view(false, None, None)
}

fn names(view: &ScratchView, dir: &str) -> Vec<String> {
    let mut names: Vec<String> = view
        .as_dyn()
        .read_dir(Path::new(dir))
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.path.display().to_string())
        .collect();
    names.sort();
    names
}

/// Runs `scratch`'s fetchers until the returned guard is dropped.
struct Fetching<'s> {
    scratch: &'s Scratch,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl Drop for Fetching<'_> {
    fn drop(&mut self) {
        self.scratch.stop();
        for t in self.threads.drain(..) {
            t.join().unwrap();
        }
    }
}

fn fetching<'s>(scratch: &'s Scratch, side: Arc<Side>) -> Fetching<'s> {
    let threads = (0..2)
        .map(|_| {
            let (scratch, side) = (scratch.clone(), side.clone());
            std::thread::spawn(move || scratch.fetch(side.as_ref(), CAP))
        })
        .collect();
    Fetching { scratch, threads }
}

#[test]
fn a_file_shows_on_the_other_runner_before_its_bytes_and_reads_once_they_come() {
    let (objects, one, two) = pair();
    let (a, b) = (scratch(), scratch());
    view(&a).write("/build/out.txt", b"hello").unwrap();
    assert_eq!(a.publish(&one, &no_secrets(), CAP), Published::Layer(1));
    assert_eq!(a.publish(&one, &no_secrets(), CAP), Published::Nothing);
    assert_eq!(objects.layers.lock().unwrap()["ci-1"], 1);

    b.catch_up(&two, "ci-1", 1).unwrap();
    let seen = view(&b);
    // Listed, with its size, though nothing of it is here yet.
    assert_eq!(names(&seen, "/build"), ["/build/out.txt"]);
    assert_eq!(
        seen.as_dyn()
            .metadata(Path::new("/build/out.txt"))
            .unwrap()
            .len,
        5
    );
    assert!(b.fs().read("/build/out.txt").is_err());
    assert!(
        objects
            .read
            .lock()
            .unwrap()
            .iter()
            .all(|n| n.ends_with(".list"))
    );

    let _fetching = fetching(&b, Arc::new(two));
    assert_eq!(seen.read("/build/out.txt").unwrap(), b"hello");
    assert_eq!(b.fs().read("/build/out.txt").unwrap(), b"hello");
}

#[test]
fn a_file_is_sent_once_it_is_closed() {
    let (_, one, _) = pair();
    let a = scratch();
    let fs = view(&a).as_dyn();
    let file = fs
        .new_open_options()
        .write(true)
        .create(true)
        .open(Path::new("/log.txt"))
        .unwrap();
    assert_eq!(a.publish(&one, &no_secrets(), CAP), Published::Nothing);
    drop(file);
    assert_eq!(a.publish(&one, &no_secrets(), CAP), Published::Layer(1));
}

#[test]
fn deletes_and_renames_reach_the_other_runner() {
    let (_, one, two) = pair();
    let (a, b) = (scratch(), scratch());
    let mine = view(&a);
    mine.write("/old.txt", b"1").unwrap();
    mine.write("/gone.txt", b"2").unwrap();
    a.publish(&one, &no_secrets(), CAP);
    b.catch_up(&two, "ci-1", a.layers()).unwrap();
    let _fetching = fetching(&b, Arc::new(two));
    assert_eq!(names(&view(&b), "/"), ["/gone.txt", "/old.txt"]);

    futures::executor::block_on(
        mine.as_dyn()
            .rename(Path::new("/old.txt"), Path::new("/new.txt")),
    )
    .unwrap();
    mine.as_dyn().remove_file(Path::new("/gone.txt")).unwrap();
    assert_eq!(a.publish(&one, &no_secrets(), CAP), Published::Layer(2));
    b.catch_up(&one_as_reader(&one), "ci-1", 2).unwrap();
    let theirs = view(&b);
    assert_eq!(names(&theirs, "/"), ["/new.txt"]);
    assert_eq!(theirs.read("/new.txt").unwrap(), b"1");
}

/// `side`'s store, read as the other runner.
fn one_as_reader(side: &Side) -> Side {
    Side {
        objects: side.objects.clone(),
        runner: "ci-2",
        helper: true,
    }
}

#[test]
fn a_newer_write_here_wins_over_another_runners_layer() {
    let (_, one, two) = pair();
    let (a, b) = (scratch(), scratch());
    view(&a).write("/shared.txt", b"theirs").unwrap();
    a.publish(&one, &no_secrets(), CAP);
    // Written here and not sent yet when their layer arrives.
    view(&b).write("/shared.txt", b"ours").unwrap();
    b.catch_up(&two, "ci-1", 1).unwrap();
    assert_eq!(view(&b).read("/shared.txt").unwrap(), b"ours");
}

#[test]
fn what_may_not_leave_shows_but_does_not_open_and_the_view_says_why() {
    let (objects, one, two) = pair();
    let a = scratch();
    let secret = "s3cr3t-value".to_string();
    let mask = Masker::new([&secret]);
    // A job that reads secrets wrote one file; another job wrote a file
    // that holds the secret's value; a third wrote a plain one.
    a.view(true, None, None)
        .write("/tainted.txt", b"derived")
        .unwrap();
    view(&a).write("/leak.txt", secret.as_bytes()).unwrap();
    view(&a).write("/plain.txt", b"fine").unwrap();
    assert_eq!(a.publish(&one, &mask, CAP), Published::Layer(1));
    let stored = objects.stored.lock().unwrap().clone();
    assert!(
        stored
            .values()
            .all(|bytes| !String::from_utf8_lossy(&decode_all(bytes)).contains(&secret)),
        "no secret is stored"
    );

    let b = scratch();
    b.catch_up(&two, "ci-1", 1).unwrap();
    let _fetching = fetching(&b, Arc::new(two));
    let theirs = view(&b);
    assert_eq!(
        names(&theirs, "/"),
        ["/leak.txt", "/plain.txt", "/tainted.txt"]
    );
    assert_eq!(theirs.read("/plain.txt").unwrap(), b"fine");
    assert!(theirs.withheld().is_none());
    assert!(theirs.read("/tainted.txt").is_err());
    let why = theirs.withheld().unwrap();
    assert!(
        why.contains("/tmp/workflow/tainted.txt") && why.contains("ci-1"),
        "{why}"
    );
    // Its contents never come: nothing to fetch.
    b.settle(&|| false).unwrap();
}

fn decode_all(bytes: &[u8]) -> Vec<u8> {
    match decode(bytes, CAP) {
        Ok(entries) => entries
            .into_iter()
            .flat_map(|e| match e {
                Entry::File { data, .. } => data.to_vec(),
                _ => Vec::new(),
            })
            .collect(),
        // A layer's list.
        Err(_) => bytes.to_vec(),
    }
}

#[test]
fn a_large_file_travels_alone_and_small_ones_together() {
    let (objects, one, two) = pair();
    let a = scratch();
    let mine = view(&a);
    mine.write("/big.bin", &vec![7u8; OWN_OBJECT as usize])
        .unwrap();
    for n in 0..5 {
        mine.write(format!("/small/{n}.txt"), b"x").unwrap();
    }
    assert_eq!(a.publish(&one, &no_secrets(), CAP), Published::Layer(1));
    let mut stored: Vec<String> = objects
        .stored
        .lock()
        .unwrap()
        .keys()
        .map(|(_, name)| name.clone())
        .collect();
    stored.sort();
    assert_eq!(stored, ["1.0", "1.1", "1.list"]);

    // Opening a small file fetches its object and not the large one.
    let b = scratch();
    b.catch_up(&two, "ci-1", 1).unwrap();
    {
        let waiting = view(&b);
        let reader = std::thread::spawn(move || waiting.read("/small/3.txt").unwrap());
        // Once the reader waits, its object is the first to fetch.
        let small = Object {
            runner: "ci-1".into(),
            name: "1.1".into(),
        };
        while b.lock().queue.front() != Some(&small) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let (scratch, side) = (b.clone(), Arc::new(two));
        let fetcher = std::thread::spawn(move || scratch.fetch(side.as_ref(), CAP));
        assert_eq!(reader.join().unwrap(), b"x");
        b.stop();
        fetcher.join().unwrap();
    }
    let read = objects.read.lock().unwrap().clone();
    let small = read.iter().position(|n| n == "1.1").unwrap();
    assert!(
        read.iter()
            .position(|n| n == "1.0")
            .is_none_or(|big| big > small),
        "{read:?}"
    );
}

#[test]
fn a_helper_past_what_it_may_send_sends_nothing_and_drops_it() {
    let (objects, _, two) = pair();
    let a = scratch();
    view(&a).write("/a.bin", &[1u8; 100]).unwrap();
    assert_eq!(a.publish(&two, &no_secrets(), 50), Published::TooMuch);
    assert!(objects.stored.lock().unwrap().is_empty());
    assert!(!a.spoiled());
    a.forget_unsent();
    assert!(a.spoiled());
    assert_eq!(a.publish(&two, &no_secrets(), CAP), Published::Nothing);
}

#[test]
fn the_primary_past_what_it_may_send_withholds_the_rest() {
    let (objects, one, two) = pair();
    let a = scratch();
    view(&a).write("/a.bin", &[1u8; 40]).unwrap();
    view(&a).write("/b.bin", &[2u8; 40]).unwrap();
    assert_eq!(a.publish(&one, &no_secrets(), 50), Published::Layer(1));
    let list: Layer =
        serde_json::from_slice(&objects.stored.lock().unwrap()[&("ci-1".into(), "1.list".into())])
            .unwrap();
    assert_eq!(list.entries.len(), 2, "{list:?}");
    assert!(
        list.entries
            .iter()
            .any(|e| matches!(e, LayerEntry::File { path, .. } if path == "/a.bin"))
    );
    assert!(
        list.entries
            .iter()
            .any(|e| matches!(e, LayerEntry::Withheld { path, size: 40 } if path == "/b.bin"))
    );
    let b = scratch();
    b.catch_up(&two, "ci-1", 1).unwrap();
    assert!(view(&b).read("/b.bin").is_err());
}

#[test]
fn a_wait_for_a_file_that_does_not_come_ends_with_the_job() {
    let (_, one, two) = pair();
    let a = scratch();
    view(&a).write("/late.txt", b"x").unwrap();
    a.publish(&one, &no_secrets(), CAP);
    let b = scratch();
    b.catch_up(&two, "ci-1", 1).unwrap();
    // No fetcher: the file never comes.
    let cancel = iwci_runtime::Cancel::new();
    let waiting = b.view(false, Some(cancel.clone()), None);
    let reader = std::thread::spawn(move || waiting.read("/late.txt").is_err());
    std::thread::sleep(Duration::from_millis(150));
    cancel.cancel();
    assert!(reader.join().unwrap());
    let past = b.view(false, None, Some(Instant::now()));
    assert!(past.read("/late.txt").is_err());
    assert!(b.settle(&|| true).is_err());
}

#[test]
fn a_store_that_does_not_answer_at_first_still_brings_the_file() {
    let (objects, one, two) = pair();
    let a = scratch();
    view(&a).write("/x.txt", b"eventually").unwrap();
    a.publish(&one, &no_secrets(), CAP);
    let b = scratch();
    b.catch_up(&two, "ci-1", 1).unwrap();
    objects.failing.store(3, Ordering::SeqCst);
    let _fetching = fetching(&b, Arc::new(two));
    assert_eq!(view(&b).read("/x.txt").unwrap(), b"eventually");
}

#[test]
fn a_layer_is_taken_in_once_whoever_asks() {
    let (objects, one, two) = pair();
    let a = scratch();
    view(&a).write("/one.txt", b"1").unwrap();
    a.publish(&one, &no_secrets(), CAP);
    view(&a).write("/two.txt", b"2").unwrap();
    a.publish(&one, &no_secrets(), CAP);
    let b = scratch();
    b.catch_up(&two, "ci-1", 2).unwrap();
    b.catch_up(&two, "ci-1", 1).unwrap();
    b.catch_up(&two, "ci-1", 2).unwrap();
    let lists = objects
        .read
        .lock()
        .unwrap()
        .iter()
        .filter(|n| n.ends_with(".list"))
        .count();
    assert_eq!(lists, 2);
    // Its own layers are never read back.
    a.catch_up(&one, "ci-1", 2).unwrap();
}

#[test]
fn a_run_on_one_runner_follows_nothing() {
    let (objects, one, _) = pair();
    let alone = Scratch::new(iwci_vfs::SnapshotBuilder::new().freeze().fork(), false);
    let mine = view(&alone);
    mine.write("/a.txt", b"x").unwrap();
    assert_eq!(alone.publish(&one, &no_secrets(), CAP), Published::Nothing);
    assert!(objects.stored.lock().unwrap().is_empty());
    assert_eq!(mine.read("/a.txt").unwrap(), b"x");
}

#[test]
fn a_bad_layer_is_refused() {
    let (objects, _, two) = pair();
    objects.stored.lock().unwrap().insert(
        ("ci-1".into(), "1.list".into()),
        serde_json::to_vec(&Layer {
            entries: vec![LayerEntry::File {
                path: "/../../etc/passwd".into(),
                size: 1,
                object: "1.0".into(),
            }],
        })
        .unwrap(),
    );
    let b = scratch();
    assert!(b.catch_up(&two, "ci-1", 1).is_err());
    objects.stored.lock().unwrap().insert(
        ("ci-1".into(), "1.list".into()),
        serde_json::to_vec(&Layer {
            entries: vec![LayerEntry::File {
                path: "/a".into(),
                size: 1,
                object: "../../other/1.0".into(),
            }],
        })
        .unwrap(),
    );
    assert!(b.catch_up(&two, "ci-1", 1).is_err());
    assert!(object_name("12.list") && object_name("3.0"));
    assert!(!object_name("x.list") && !object_name("1.") && !object_name("1.a/b"));
}
