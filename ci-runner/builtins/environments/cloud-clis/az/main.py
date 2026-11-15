"""`az` in env:az: the Azure CLI on the environment's CPython, from its two
site directories (the management SDKs are a package of their own; see
build.sh), signed in by itself when a job is lent a service principal.

A lent Azure connection sets AZURE_CLIENT_ID, AZURE_TENANT_ID and
AZURE_CLIENT_SECRET (and AZURE_SUBSCRIPTION_ID). The CLI reads none of them
itself, so the first `az` of a job that has them and is signed in to
nothing runs `az login --service-principal` with them, and `az account set`
with the subscription, before the command it was asked for. A job that
signs in itself (`az login`), or has already, is left alone.
"""

import errno
import fcntl
import json
import os
import runpy
import site
import subprocess
import sys

for directory in ("/opt/azure-cli/site", "/opt/azure-cli-mgmt/site"):
    site.addsitedir(directory)

# The CLI keeps its token cache under a file lock (msal-extensions, through
# portalocker's fcntl.flock), and flock fails with ENOSYS in a job, which
# stopped `az login` once it had its token. A job's `az`s run one after
# another, so where there is no lock to take it goes on without one.
_flock = fcntl.flock


def flock(fd, operation):
    try:
        return _flock(fd, operation)
    except OSError as err:
        if err.errno != errno.ENOSYS:
            raise


fcntl.flock = flock

# Commands that need no account, or are the job signing in or out itself.
NO_SIGN_IN = {"login", "logout", "version", "--version", "-h", "--help", "cloud", "config"}


def signed_in():
    config_dir = os.environ.get("AZURE_CONFIG_DIR") or os.path.expanduser("~/.azure")
    try:
        with open(os.path.join(config_dir, "azureProfile.json"), encoding="utf-8-sig") as f:
            return bool(json.load(f).get("subscriptions"))
    except (OSError, ValueError):
        return False


def az(*args):
    """Another `az` in a child, so its output and exit are its own."""
    return subprocess.run([sys.executable or "/usr/bin/python3", "-E", "-s", "-S", __file__, *args]).returncode


def sign_in():
    client, tenant, secret = (os.environ.get(k) for k in ("AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"))
    if not (client and tenant and secret) or signed_in():
        return 0
    status = az(
        "login", "--service-principal", "--username", client, f"--password={secret}",
        "--tenant", tenant, "--output", "none",
    )
    subscription = os.environ.get("AZURE_SUBSCRIPTION_ID")
    if status == 0 and subscription:
        status = az("account", "set", "--subscription", subscription)
    if status != 0:
        print("az: could not sign in with the lent service principal (AZURE_CLIENT_ID)", file=sys.stderr)
    return status


args = sys.argv[1:]
if args and args[0] not in NO_SIGN_IN and os.environ.get("IWCI_AZ_SIGNING_IN") != "1":
    os.environ["IWCI_AZ_SIGNING_IN"] = "1"
    status = sign_in()
    del os.environ["IWCI_AZ_SIGNING_IN"]
    if status != 0:
        sys.exit(status)

sys.argv[0] = "az"
runpy.run_module("azure.cli", run_name="__main__", alter_sys=True)
