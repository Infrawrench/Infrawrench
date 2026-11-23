//! The user a Linux machine's scripts run as.
//!
//! An image with the job user (`runner`, uid [`JOB_UID`], home `/root`)
//! runs scripts as that user when the runner names it on the kernel's
//! command line (`iwci.user=1001`), as GitHub's hosted runners do: test
//! suites that check a `chmod 000` file cannot be read, or a directory
//! cannot be written, only pass for a user the kernel holds to permissions.
//! The runner names it only when it also serves the job's files as that
//! user's, so the job can write its checkout. Without it, as before, they
//! run as root.

use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::OnceLock;

use iwci_vm_proto::{JOB_UID, USER_ARG};

/// The user scripts run as, with the groups `/etc/group` puts it in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobUser {
    pub uid: u32,
    pub gid: u32,
    /// Supplementary groups (its own first): `docker`, so it reaches the
    /// daemon without sudo.
    pub groups: Vec<u32>,
    pub name: String,
}

/// The uid the kernel's command line names, if it is the job user's.
pub fn uid_from_cmdline(cmdline: &str) -> Option<u32> {
    let prefix = format!("{USER_ARG}=");
    cmdline
        .split_whitespace()
        .find_map(|word| word.strip_prefix(&prefix))
        .and_then(|uid| uid.parse().ok())
        // Only the user the image made: a command line cannot pick another.
        .filter(|uid| *uid == JOB_UID)
}

/// The groups `/etc/group` lists `name` as a member of, after `gid`.
pub fn groups_of(etc_group: &str, name: &str, gid: u32) -> Vec<u32> {
    let mut out = vec![gid];
    for line in etc_group.lines() {
        let mut fields = line.split(':');
        let (Some(_), Some(_), Some(id), Some(members)) =
            (fields.next(), fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Ok(id) = id.parse::<u32>() else { continue };
        if !out.contains(&id) && members.split(',').any(|m| m == name) {
            out.push(id);
        }
    }
    out
}

/// The job user for this machine, read once from `/proc/cmdline` and
/// `/etc/group`; `None` runs scripts as root.
pub fn current() -> Option<&'static JobUser> {
    static USER: OnceLock<Option<JobUser>> = OnceLock::new();
    USER.get_or_init(|| {
        let cmdline = std::fs::read_to_string("/proc/cmdline").ok()?;
        let uid = uid_from_cmdline(&cmdline)?;
        let name = "runner".to_string();
        let etc_group = std::fs::read_to_string("/etc/group").unwrap_or_default();
        Some(JobUser {
            uid,
            gid: uid,
            groups: groups_of(&etc_group, &name, uid),
            name,
        })
    })
    .as_ref()
}

impl JobUser {
    /// Sets the user's name for `cmd` (its home stays `/root`, which the
    /// image gave it) and switches to it between fork and exec. Called after
    /// anything else that must still run as root in the child, such as
    /// moving it into its cgroup, since pre-exec hooks run in order.
    pub fn apply(&self, cmd: &mut Command) {
        cmd.env("USER", &self.name).env("LOGNAME", &self.name);
        let (uid, gid) = (self.uid, self.gid);
        let groups: Vec<libc::gid_t> = self.groups.clone();
        // SAFETY: only async-signal-safe calls (setgroups, setgid, setuid)
        // on memory allocated before the fork.
        unsafe {
            cmd.pre_exec(move || {
                if libc::setgroups(groups.len(), groups.as_ptr()) != 0
                    || libc::setgid(gid) != 0
                    || libc::setuid(uid) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_job_users_uid_is_taken_from_the_command_line() {
        assert_eq!(
            uid_from_cmdline("console=hvc0 iwci.files=iwci-files iwci.user=1001"),
            Some(1001)
        );
        assert_eq!(uid_from_cmdline("console=hvc0"), None);
        assert_eq!(uid_from_cmdline("iwci.user=0"), None);
        assert_eq!(uid_from_cmdline("iwci.user=abc"), None);
    }

    #[test]
    fn groups_are_its_own_then_those_it_is_a_member_of() {
        let etc_group = "root:x:0:\nsudo:x:27:runner\ndocker:x:998:runner,other\nrunner:x:1001:\nusers:x:100:someone\n";
        assert_eq!(groups_of(etc_group, "runner", 1001), vec![1001, 27, 998]);
    }
}
