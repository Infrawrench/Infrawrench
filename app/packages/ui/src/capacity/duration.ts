import { useCallback } from "react";
import { useGT } from "gt-react";

/**
 * A runway in the reader's language, coarsening as it grows: days under a
 * fortnight, then weeks, then months, the steps `formatRunwayDays` uses for
 * the CLI and the alert text. "213 days" implies a precision a fortnight of
 * readings cannot support; "7 months" is the honest rendering further out.
 */
export function useRunwayDuration(): (days: number) => string {
  const gt = useGT();
  return useCallback(
    (days: number) => {
      if (days < 1) return gt("under a day");
      if (days < 14) {
        return gt("{count, plural, one {# day} other {# days}}", { count: Math.round(days) });
      }
      if (days < 60) {
        return gt("{count, plural, one {# week} other {# weeks}}", {
          count: Math.round(days / 7),
        });
      }
      return gt("{count, plural, one {# month} other {# months}}", {
        count: Math.round(days / 30),
      });
    },
    [gt],
  );
}
