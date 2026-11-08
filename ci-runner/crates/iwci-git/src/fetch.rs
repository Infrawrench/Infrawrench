//! Opening the per-remote repository and fetching one commit into it.

use std::collections::HashSet;
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use gix::ObjectId;
use gix::bstr::ByteSlice;
use gix::remote::Direction;
use gix::remote::fetch::{Shallow, Status, Tags};

use crate::{Auth, Depth, Fetched, GitError, RemoteCache, Result, find_commit};

/// Written last when a repository is created, so a directory left half
/// made by a crash is recognised and started over rather than trusted.
const READY_MARKER: &str = "iwci-ready";

/// Every fetched commit gets a ref here. The refs keep nothing alive (the
/// cache is never garbage collected); they exist because gix sends every
/// local ref as a `have` during negotiation, so the server can leave out
/// objects the cache already holds when the next commit is fetched.
const COMMIT_REFS: &str = "refs/iwci/c/";
const HINT_REF: &str = "refs/iwci/hint";
/// The newest commit refs to keep. Enough to cover the branches in flight
/// at once, few enough that negotiation stays cheap.
const KEEP_COMMIT_REFS: usize = 64;

/// A refspec that matches nothing. A fetch whose only refspec is a bare
/// sha gives gix no `ref-prefix` to send, and an `ls-refs` with no prefix
/// lists every ref on the server, which on a busy GitHub repository is
/// tens of thousands of `refs/pull/*`. This narrows the listing to none.
const MATCH_NO_REFS: &str = "refs/iwci-matches-nothing";

/// When the commit is not within `depth` of the hint's tip (the branch moved
/// on between the push and this fetch), the hint is fetched once more this
/// deep before giving up.
const HINT_RETRY_DEPTH: u32 = 64;

/// Settings applied in memory on every open. Nothing here is written to the
/// repository's config file.
const CONFIG_OVERRIDES: &[&str] = &[
    // The ref updates a fetch makes write reflog entries that need an
    // identity; the cache has no user, and the reflogs are of no use.
    "core.logAllRefUpdates=false",
    "user.name=iwci",
    "user.email=iwci@localhost",
    "gitoxide.userAgent=iwci",
];

pub(crate) fn install_tls_provider() {
    // reqwest is built without a crypto provider of its own (see
    // Cargo.toml) and uses the process default. Installing fails only when
    // something else already installed one, which is just as good.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub(crate) fn is_ready(git_dir: &Path) -> bool {
    git_dir.join(READY_MARKER).is_file()
}

pub(crate) fn open_repo(git_dir: &Path) -> Result<gix::Repository> {
    // Isolated: the host's global and system git config (credential
    // helpers, `url.*.insteadOf`, hooks paths) must not change what a CI
    // fetch does.
    let options = gix::open::Options::isolated().config_overrides(CONFIG_OVERRIDES.iter().copied());
    Ok(gix::open_opts(git_dir, options)?)
}

fn io_err(path: &Path) -> impl FnOnce(std::io::Error) -> GitError + '_ {
    move |source| GitError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// Creates the repository if it is missing or half made. Exclusive lock
/// held by the caller.
fn init_repo(cache: &RemoteCache) -> Result<gix::Repository> {
    let git_dir = &cache.git_dir;
    if is_ready(git_dir) {
        return open_repo(git_dir);
    }
    if git_dir.exists() {
        std::fs::remove_dir_all(git_dir).map_err(io_err(git_dir))?;
    }
    drop(gix::init_bare(git_dir)?);
    // For a person poking at the cache directory: which remote this is.
    let url_file = git_dir.join("iwci-remote");
    std::fs::write(&url_file, format!("{}\n", cache.remote.normalised))
        .map_err(io_err(&url_file))?;
    let marker = git_dir.join(READY_MARKER);
    std::fs::write(&marker, b"").map_err(io_err(&marker))?;
    open_repo(git_dir)
}

fn pack_count(git_dir: &Path) -> usize {
    std::fs::read_dir(git_dir.join("objects").join("pack"))
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|ext| ext == "pack"))
                .count()
        })
        .unwrap_or(0)
}

pub(crate) fn validate_hint(hint: &str) -> Result<()> {
    let bad = || GitError::BadRefHint(hint.to_owned());
    // The hint becomes the source side of a refspec, so anything that
    // would make it a pattern, a negation, a force marker or a second
    // refspec is out, on top of git's own ref name rules.
    if hint.is_empty()
        || hint.starts_with(['+', '^', '-'])
        || hint.contains([':', '*', '?', '[', '\\', ' ', '~'])
        || hint.chars().any(char::is_control)
    {
        return Err(bad());
    }
    gix::validate::reference::name_partial(hint.as_bytes().as_bstr()).map_err(|_| bad())?;
    Ok(())
}

pub(crate) fn fetch_commit(
    cache: &RemoteCache,
    commit: ObjectId,
    depth: Depth,
    auth: Option<&Auth>,
    ref_hint: Option<&str>,
) -> Result<Fetched> {
    let mut repo = init_repo(cache)?;
    if has_history(&repo, commit, depth)? {
        let tree = find_commit(&repo, commit)?.tree_id()?.detach();
        return Ok(Fetched {
            commit: commit.to_string(),
            tree: tree.to_string(),
            from_network: false,
            via_ref_hint: false,
            objects_received: 0,
        });
    }
    if pack_count(&cache.git_dir) > cache.max_packs {
        std::fs::remove_dir_all(&cache.git_dir).map_err(io_err(&cache.git_dir))?;
        repo = init_repo(cache)?;
    }

    let shallow = |depth: Depth| -> Result<Shallow> {
        Ok(match depth {
            Depth::Shallow(n) => {
                Shallow::DepthAtRemote(NonZeroU32::new(n).unwrap_or(NonZeroU32::MIN))
            }
            // Only a shallow repository has a boundary to remove; asking a
            // complete one to "undo" would make gix treat it as a deepen.
            Depth::Full if repo.is_shallow()? => Shallow::undo(),
            Depth::Full => Shallow::NoChange,
        })
    };

    let by_sha = transfer(
        &repo,
        cache,
        &format!("+{commit}:{COMMIT_REFS}{commit}"),
        shallow(depth)?,
        auth,
    );
    let (objects_received, via_ref_hint) = match (by_sha, ref_hint) {
        (Ok(n), _) if repo.has_object(commit) => (n, false),
        (Ok(_), None) => {
            return Err(GitError::NotReachable {
                commit: commit.to_string(),
                hint: None,
            });
        }
        (Err(e), None) => return Err(e),
        (by_sha, Some(hint)) => {
            let by_sha_err = by_sha.err();
            match fetch_through_hint(&repo, cache, commit, depth, auth, hint, &shallow) {
                Ok(n) => (n, true),
                Err(by_hint) => {
                    return Err(match by_sha_err {
                        Some(by_sha) => GitError::FetchFailed {
                            commit: commit.to_string(),
                            hint: hint.to_owned(),
                            by_sha: Box::new(by_sha),
                            by_hint: Box::new(by_hint),
                        },
                        None => by_hint,
                    });
                }
            }
        }
    };

    // A fresh handle: the one above may hold a stale view of the packs.
    let repo = open_repo(&cache.git_dir)?;
    let tree = find_commit(&repo, commit)?.tree_id()?.detach();
    if via_ref_hint {
        repo.reference(
            format!("{COMMIT_REFS}{commit}"),
            commit,
            gix::refs::transaction::PreviousValue::Any,
            "iwci: found through ref hint",
        )?;
    }
    prune_commit_refs(&repo)?;
    Ok(Fetched {
        commit: commit.to_string(),
        tree: tree.to_string(),
        from_network: true,
        via_ref_hint,
        objects_received,
    })
}

fn fetch_through_hint(
    repo: &gix::Repository,
    cache: &RemoteCache,
    commit: ObjectId,
    depth: Depth,
    auth: Option<&Auth>,
    hint: &str,
    shallow: &dyn Fn(Depth) -> Result<Shallow>,
) -> Result<u64> {
    let refspec = format!("+{hint}:{HINT_REF}");
    let mut received = transfer(repo, cache, &refspec, shallow(depth)?, auth)?;
    if !repo.has_object(commit)
        && let Depth::Shallow(n) = depth
        && n < HINT_RETRY_DEPTH
    {
        received += transfer(
            repo,
            cache,
            &refspec,
            shallow(Depth::Shallow(HINT_RETRY_DEPTH))?,
            auth,
        )?;
    }
    if !repo.has_object(commit) {
        return Err(GitError::NotReachable {
            commit: commit.to_string(),
            hint: Some(hint.to_owned()),
        });
    }
    Ok(received)
}

/// One fetch with one refspec. Returns the number of objects received.
fn transfer(
    repo: &gix::Repository,
    cache: &RemoteCache,
    refspec: &str,
    shallow: Shallow,
    auth: Option<&Auth>,
) -> Result<u64> {
    let remote = repo
        .remote_at_without_url_rewrite(cache.remote.fetch_url.clone())?
        .with_fetch_tags(Tags::None)
        .with_refspecs([refspec], Direction::Fetch)?;
    let host = cache.remote.fetch_url.host().map(str::to_owned);
    let auth = auth.cloned();
    // Always a callback, even without a token: the default would run the
    // host's credential helpers or prompt on a terminal. The token is only
    // offered to the remote's own host, so a redirect elsewhere does not
    // collect it.
    let connection = remote
        .connect(Direction::Fetch)?
        .with_credentials(move |action| {
            use gix::credentials::helper::Action;
            let Action::Get(context) = action else {
                return Ok(None);
            };
            let Some(auth) = auth.as_ref() else {
                return Ok(None);
            };
            if context.host.as_deref() != host.as_deref() {
                return Ok(None);
            }
            Ok(Some(gix::credentials::protocol::Outcome {
                identity: gix::sec::identity::Account {
                    username: auth.username.clone(),
                    password: auth.secret.clone(),
                    oauth_refresh_token: None,
                },
                next: context.into(),
            }))
        });
    let options = gix::remote::ref_map::Options {
        extra_refspecs: vec![
            gix::refspec::parse(
                MATCH_NO_REFS.as_bytes().as_bstr(),
                gix::refspec::parse::Operation::Fetch,
            )
            .expect("a valid refspec")
            .to_owned(),
        ],
        ..Default::default()
    };
    let outcome = connection
        .prepare_fetch(gix::progress::Discard, options)?
        .with_shallow(shallow)
        .receive(gix::progress::Discard, &AtomicBool::new(false))?;
    Ok(match outcome.status {
        Status::Change {
            write_pack_bundle, ..
        } => write_pack_bundle.index.num_objects.into(),
        Status::NoPackReceived { .. } => 0,
    })
}

/// Whether `commit` is present along with `depth` generations of history.
///
/// Presence of a commit object implies its whole tree is present: packs
/// from a fetch are closed under reachability except across the shallow
/// boundary, and that boundary only ever cuts parent links. So history is a
/// question of which parent commits are present, and the shallow file need
/// not be consulted except for `Full`.
fn has_history(repo: &gix::Repository, commit: ObjectId, depth: Depth) -> Result<bool> {
    let Ok(start) = find_commit(repo, commit) else {
        return Ok(false);
    };
    let generations = match depth {
        Depth::Shallow(n) => n.max(1) - 1,
        Depth::Full if !repo.is_shallow()? => return Ok(true),
        Depth::Full => u32::MAX,
    };
    let mut seen = HashSet::new();
    let mut frontier: Vec<ObjectId> = start.parent_ids().map(|id| id.detach()).collect();
    for _ in 0..generations {
        if frontier.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for id in frontier {
            if !seen.insert(id) {
                continue;
            }
            let Ok(parent) = find_commit(repo, id) else {
                return Ok(false);
            };
            next.extend(parent.parent_ids().map(|id| id.detach()));
        }
        frontier = next;
    }
    Ok(true)
}

/// Keeps the newest [`KEEP_COMMIT_REFS`] commit refs, by committer time.
fn prune_commit_refs(repo: &gix::Repository) -> Result<()> {
    let platform = repo.references()?;
    let mut refs: Vec<(i64, gix::Reference<'_>)> = Vec::new();
    for reference in platform.prefixed(COMMIT_REFS)? {
        let Ok(reference) = reference else { continue };
        let time = reference
            .try_id()
            .and_then(|id| find_commit(repo, id.detach()).ok())
            .and_then(|c| c.time().ok())
            .map_or(i64::MIN, |t| t.seconds);
        refs.push((time, reference));
    }
    if refs.len() <= KEEP_COMMIT_REFS {
        return Ok(());
    }
    refs.sort_by_key(|(time, _)| std::cmp::Reverse(*time));
    for (_, reference) in refs.into_iter().skip(KEEP_COMMIT_REFS) {
        reference.delete()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_that_would_change_the_refspec_are_refused() {
        for bad in [
            "",
            "+main",
            "a:b",
            "refs/heads/*",
            "^main",
            "a b",
            "a\nb",
            "-x",
        ] {
            assert!(validate_hint(bad).is_err(), "{bad:?}");
        }
        for good in ["main", "refs/heads/main", "refs/pull/7/head", "release/1.2"] {
            assert!(validate_hint(good).is_ok(), "{good:?}");
        }
    }
}
