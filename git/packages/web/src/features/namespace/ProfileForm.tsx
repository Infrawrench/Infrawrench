/**
 * Editing a profile: a person's own, in Settings > Profile, and an
 * organisation's, from its page, by its administrators. One form for both;
 * an organisation's has its picture above it (`OrganisationPicture`), which
 * a person's has not: theirs is the one on their Infrawrench account.
 */
import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { BIO_MAX_LENGTH, type Namespace } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { Button } from "../../components/Button";
import { Field, Input, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Avatar } from "../../components/people";
import { InlineError } from "../../components/states";
import { AVATAR_ACCEPT, prepareAvatar } from "../../lib/avatar-upload";

/** Everything that shows a namespace's name or picture. */
const refreshProfile = () => {
  void invalidate("namespaces");
  void invalidate("session");
  void invalidate("repositoryLists");
};

export function ProfileForm({
  namespace,
  onSaved,
}: {
  namespace: Namespace;
  /** After a save went through: a dialog closes. */
  onSaved?: () => void;
}) {
  const [displayName, setDisplayName] = useState(namespace.displayName ?? "");
  const [description, setDescription] = useState(namespace.description ?? "");
  const [website, setWebsite] = useState(namespace.websiteUrl ?? "");
  const [location, setLocation] = useState(namespace.location ?? "");
  const blank = (value: string) => (value.trim() === "" ? null : value.trim());
  const save = useMutation({
    mutationFn: () =>
      api.namespaces.update({
        params: { namespace: namespace.slug },
        payload: {
          displayName: blank(displayName),
          description: blank(description),
          websiteUrl: blank(website),
          location: blank(location),
        },
      }),
    onSuccess: () => {
      refreshProfile();
      onSaved?.();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Name" optional>
        {(control) => (
          <Input
            {...control}
            value={displayName}
            maxLength={100}
            onChange={(event) => setDisplayName(event.target.value)}
            className="max-w-sm"
          />
        )}
      </Field>
      <Field label="Bio" optional hint={`${description.length} of ${BIO_MAX_LENGTH} characters`}>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={description}
            maxLength={BIO_MAX_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Website" optional>
          {(control) => (
            <Input
              {...control}
              type="url"
              value={website}
              maxLength={500}
              placeholder="https://"
              onChange={(event) => setWebsite(event.target.value)}
            />
          )}
        </Field>
        <Field label="Location" optional>
          {(control) => (
            <Input
              {...control}
              value={location}
              maxLength={100}
              onChange={(event) => setLocation(event.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save profile
        </Button>
        <span role="status" className="text-xs text-on-surface-muted">
          {save.isSuccess && !save.isPending ? "Saved" : ""}
        </span>
        <InlineError error={save.error} />
      </div>
    </form>
  );
}

/**
 * An organisation's picture: upload one, or remove it and go back to the
 * initials. Saved as it is chosen, apart from the form under it.
 */
export function OrganisationPicture({ namespace }: { namespace: Namespace }) {
  const input = useRef<HTMLInputElement>(null);
  const params = { namespace: namespace.slug };
  const upload = useMutation({
    mutationFn: async (file: File) =>
      api.namespaces.setAvatar({ params, payload: { image: await prepareAvatar(file) } }),
    onSuccess: refreshProfile,
  });
  const remove = useMutation({
    mutationFn: () => api.namespaces.removeAvatar({ params }),
    onSuccess: refreshProfile,
  });
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same file can be chosen again after a refusal.
    event.target.value = "";
    if (file === undefined) return;
    remove.reset();
    upload.mutate(file);
  };
  const busy = upload.isPending || remove.isPending;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Avatar
          name={namespace.displayName ?? namespace.slug}
          src={namespace.avatarUrl}
          size={56}
          square
        />
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-on-surface">Picture</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={input}
              type="file"
              accept={AVATAR_ACCEPT}
              aria-label="Picture file"
              className="sr-only"
              tabIndex={-1}
              onChange={choose}
            />
            <Button
              size="sm"
              busy={upload.isPending}
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Icon name="upload" size={12} />
              Upload a picture
            </Button>
            {namespace.avatarUrl !== null ? (
              <Button
                size="sm"
                variant="ghost"
                busy={remove.isPending}
                disabled={busy}
                onClick={() => {
                  upload.reset();
                  remove.mutate();
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <p className="text-xs text-on-surface-faint">PNG, JPEG or WebP. Cropped to a square.</p>
      <InlineError error={upload.error ?? remove.error} />
    </div>
  );
}
