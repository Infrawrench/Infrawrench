# The identity provider and directory are connected by your IT admin in the
# WorkOS Admin Portal (Settings -> Single Sign-On). This holds the decisions.
resource "infrawrench_sso_settings" "this" {
  # Refused by the server until a domain is verified, a connection is active
  # and at least one break-glass owner is listed.
  enforce_sso = true

  # Owners who can still get in when the identity provider is down.
  break_glass_user_ids = ["user_01HXYZABCDEFGHJKMNPQRSTVWX"]

  provisioning_enabled = true
  auto_add_seats       = false
}
