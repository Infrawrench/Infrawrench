// The wire types come from `@infrawrench/client-core`; this module only adds
// the client seam a host must provide.
import type {
  GameDay,
  GameDayCandidates,
  GameDayDetail,
  GameDayInput,
  GameDayPlan,
} from "@infrawrench/client-core";
import type { BlastRadiusClient } from "../blast-radius/types.js";

/**
 * What a host must provide for the game days panel. The `game-days:run`
 * methods are optional: without them the panel is read-only (the `SlosClient`
 * convention). `abortGameDay` is separate because every member holds it.
 */
export interface GameDaysClient {
  listGameDays(): Promise<GameDay[]>;
  getGameDay(gameDayId: string): Promise<GameDayDetail>;
  listCandidates(): Promise<GameDayCandidates>;
  abortGameDay?(gameDayId: string): Promise<GameDay>;
  planGameDay?(input: GameDayInput): Promise<GameDayPlan>;
  createGameDay?(input: GameDayInput): Promise<GameDay>;
  updateGameDay?(gameDayId: string, input: GameDayInput): Promise<GameDay>;
  deleteGameDay?(gameDayId: string): Promise<void>;
  armGameDay?(gameDayId: string, confirmName: string): Promise<GameDay>;
  disarmGameDay?(gameDayId: string): Promise<GameDay>;
  endGameDay?(gameDayId: string): Promise<GameDay>;
  retryUndo?(gameDayId: string): Promise<GameDay>;
  /** Shown per target before arming; omitted, the confirmation shows only the dry run. */
  blastRadius?: BlastRadiusClient;
}
