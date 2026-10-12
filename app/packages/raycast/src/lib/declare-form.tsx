import {
  Action,
  ActionPanel,
  Alert,
  Form,
  Icon,
  Toast,
  confirmAlert,
  open,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useState } from "react";
import {
  DEFAULT_INCIDENT_SEVERITY,
  INCIDENT_LIMITS,
  declareIncident,
  defaultIncidentActions,
  incidentSeverityLabel,
  type IncidentSeverity,
} from "@infrawrench/client-core";
import { getClient } from "./client";
import { SEVERITY_OPTIONS } from "./format";
import { destinationsFor } from "./open";

interface Values {
  title: string;
  severity: string;
  summary: string;
  postSlack: boolean;
  pinMoment: boolean;
  openFreeze: boolean;
}

/**
 * Declare an incident. Declaring pages people and posts to channels, so the
 * submit asks for confirmation first, naming the severity and the title.
 */
export function DeclareIncidentForm(props: {
  affectedResourceIds?: string[];
  affectedLabel?: string;
  defaultTitle?: string;
}) {
  const [titleError, setTitleError] = useState<string | undefined>();
  const defaults = defaultIncidentActions();

  async function submit(values: Values) {
    const title = values.title.trim();
    if (!title) {
      setTitleError("A title is required");
      return;
    }
    const severity = values.severity as IncidentSeverity;
    const confirmed = await confirmAlert({
      title: `Declare a ${incidentSeverityLabel(severity)} incident?`,
      message: `"${title}"${props.affectedLabel ? ` affecting ${props.affectedLabel}` : ""}. This notifies your incident channels.`,
      icon: Icon.ExclamationMark,
      primaryAction: { title: "Declare Incident", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Declaring incident" });
    try {
      const client = getClient();
      const incident = await declareIncident(client.api, client.orgId, {
        title,
        severity,
        summary: values.summary.trim() || null,
        ...(props.affectedResourceIds?.length
          ? { affectedResourceIds: props.affectedResourceIds }
          : {}),
        actions: {
          postSlack: values.postSlack,
          pinMoment: values.pinMoment,
          openFreeze: values.openFreeze,
        },
      });
      if (!incident) throw new Error("No incident came back");
      const dest = destinationsFor(client, {
        kind: "incident",
        orgId: client.orgId,
        incidentId: incident.id,
      });
      toast.style = Toast.Style.Success;
      toast.title = `${incidentSeverityLabel(incident.severity)} declared`;
      toast.message = incident.title;
      toast.primaryAction = {
        title: "Open Incident",
        onAction: () => void open(client.openIn === "desktop" ? dest.desktop : dest.web),
      };
      await popToRoot();
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "Couldn't declare the incident";
      toast.message = err instanceof Error ? err.message : String(err);
    }
  }

  return (
    <Form
      navigationTitle="Declare Incident"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Declare Incident"
            icon={Icon.ExclamationMark}
            onSubmit={submit}
          />
        </ActionPanel>
      }
    >
      {props.affectedLabel ? (
        <Form.Description title="Affecting" text={props.affectedLabel} />
      ) : null}
      <Form.TextField
        id="title"
        title="Title"
        placeholder="Checkout returning 500s"
        defaultValue={props.defaultTitle ?? ""}
        error={titleError}
        onChange={() => setTitleError(undefined)}
        info={`Up to ${INCIDENT_LIMITS.maxTitleLength} characters.`}
      />
      <Form.Dropdown id="severity" title="Severity" defaultValue={DEFAULT_INCIDENT_SEVERITY}>
        {SEVERITY_OPTIONS.map((s) => (
          <Form.Dropdown.Item key={s.value} value={s.value} title={s.title} />
        ))}
      </Form.Dropdown>
      <Form.TextArea
        id="summary"
        title="Summary"
        placeholder="What is happening, what is affected"
      />
      <Form.Separator />
      <Form.Checkbox
        id="postSlack"
        label="Post to the incident Slack channel"
        defaultValue={defaults.postSlack}
      />
      <Form.Checkbox
        id="pinMoment"
        label="Pin a Moment of the current state"
        defaultValue={defaults.pinMoment}
      />
      <Form.Checkbox
        id="openFreeze"
        label="Open a change freeze"
        defaultValue={defaults.openFreeze}
      />
    </Form>
  );
}
