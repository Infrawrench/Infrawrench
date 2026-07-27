import { Sheet } from "@/components/form";
import { Button, Card, Row } from "@/components/ui";

/** What "Add a card" can add — the same four choices as web's add menu. */
export type AddCardChoice = "pin" | "cost_graph" | "new_budget" | "existing_budget";

export function AddCardSheet({
  visible,
  onChoose,
  onClose,
}: {
  visible: boolean;
  onChoose: (choice: AddCardChoice) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      title="Add a card"
      onClose={onClose}
      footer={<Button label="Cancel" variant="secondary" onPress={onClose} />}
    >
      <Card list>
        <Row
          title="Pin a resource"
          subtitle="Live status and stats for one resource"
          onPress={() => onChoose("pin")}
        />
        <Row
          title="Cost graph"
          subtitle="Spend over a range, grouped and filtered"
          onPress={() => onChoose("cost_graph")}
        />
        <Row
          title="New budget"
          subtitle="A monthly amount that alerts before the bill does"
          onPress={() => onChoose("new_budget")}
        />
        <Row
          title="Existing budget"
          subtitle="Show a budget this organization already has"
          onPress={() => onChoose("existing_budget")}
        />
      </Card>
    </Sheet>
  );
}
