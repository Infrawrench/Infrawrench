import { useLocalSearchParams } from "expo-router";
import { GameDayDetailScreen } from "@/features/game-days/GameDayDetailScreen";

/** One game day: the report, the targets and the abort button. */
export default function GameDayDetailRoute() {
  const { gameDayId } = useLocalSearchParams<{ gameDayId: string }>();
  return <GameDayDetailScreen gameDayId={gameDayId} />;
}
