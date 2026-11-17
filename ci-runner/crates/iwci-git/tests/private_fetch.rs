//! A fetch of a private repository over HTTPS with a token, the way the
//! runner clones for the app. It needs the network and a real token, so it
//! is ignored by default:
//!
//! ```sh
//! IWCI_PRIVATE_REPO=https://github.com/<owner>/<private-repo>.git \
//! IWCI_PRIVATE_BRANCH=main IWCI_PRIVATE_TOKEN=<token> \
//!   cargo test -p iwci-git --test private_fetch -- --ignored
//! ```

mod support;

use iwci_git::{Auth, Depth, GitCache};
use support::TempDir;

#[test]
#[ignore = "needs the network and a token for a private repository"]
fn a_private_repository_fetches_with_a_token() {
    let (Ok(repo), Ok(token)) = (
        std::env::var("IWCI_PRIVATE_REPO"),
        std::env::var("IWCI_PRIVATE_TOKEN"),
    ) else {
        eprintln!("skipped: IWCI_PRIVATE_REPO and IWCI_PRIVATE_TOKEN are unset");
        return;
    };
    let branch = std::env::var("IWCI_PRIVATE_BRANCH").unwrap_or_else(|_| "main".into());
    let dir = TempDir::new("private-fetch");
    let cache = GitCache::new(dir.path()).unwrap();
    let remote = cache.remote(&repo).unwrap();
    let auth = Auth::token(token);
    let fetched = remote
        .fetch_branch(&branch, Depth::Shallow(1), Some(&auth))
        .expect("the token is offered and accepted");
    assert!(remote.has_commit(&fetched.commit).unwrap());
    // Without the token the same fetch is refused, so the pass above is the
    // token's doing and not a public repository.
    let bare_dir = TempDir::new("private-fetch-bare");
    let bare = GitCache::new(bare_dir.path()).unwrap();
    assert!(
        bare.remote(&repo)
            .unwrap()
            .fetch_branch(&branch, Depth::Shallow(1), None)
            .is_err()
    );
}
