import type { OverlaySettings, TodoItem, TodoSubSource } from '@/types/settings';

export type TodoDisplayStatus = 'do_challenge' | 'waiting_subs' | 'pending' | 'completed';

export interface TodoProgressInfo {
  isSubChallenge: boolean;
  subSource: TodoSubSource;
  subLabel: string;
  subCurrent: number;
  subTarget: number;
  goalMet: boolean;
  status: TodoDisplayStatus;
}

/**
 * Returns today's daily sub count (resets cleanly to 0 if stored count is from an earlier local date).
 */
export function getEffectiveDailySubs(settings: Partial<OverlaySettings>): number {
  const todayStr = new Date().toLocaleDateString('en-CA');
  return settings.dailySubLastReset === todayStr ? (settings.dailySubCurrent || 0) : 0;
}

/**
 * Computes live progress and state for both standard To-Do tasks and Twitch Sub-Goal Challenges.
 * A Sub-Goal Challenge flips to `do_challenge` once subs >= subGoal and stays active until manually completed.
 */
export function getTodoSubProgress(
  todo: TodoItem,
  settings: Partial<OverlaySettings>
): TodoProgressInfo {
  const isSubChallenge = todo.type === 'sub_challenge' && (todo.subGoal ?? 0) > 0;
  const subSource: TodoSubSource =
    todo.subSource === 'total' ? 'total' : todo.subSource === 'daily' ? 'daily' : 'challenge';
  const defaultLabel =
    subSource === 'total'
      ? (settings.todoTotalSubsLabel?.trim() || 'TOTAL SUBS')
      : subSource === 'daily'
        ? (settings.todoDailySubsLabel?.trim() || 'DAILY SUBS')
        : (settings.todoChallengeSubsLabel?.trim() || 'SUBS');
  const subLabel = todo.subLabel?.trim() || defaultLabel;

  const rawTotal = settings.totalSubCurrent || 0;
  const rawDaily = getEffectiveDailySubs(settings);

  let subCurrent = 0;
  if (subSource === 'challenge') {
    const autoDelta = typeof todo.subBaseline === 'number' ? Math.max(0, rawTotal - todo.subBaseline) : 0;
    subCurrent = Math.max(0, (todo.current ?? 0) + autoDelta);
  } else if (subSource === 'daily') {
    subCurrent = typeof todo.subBaseline === 'number'
      ? Math.max(0, (todo.current ?? 0) + Math.max(0, rawDaily - todo.subBaseline))
      : rawDaily;
  } else {
    subCurrent = typeof todo.subBaseline === 'number'
      ? Math.max(0, (todo.current ?? 0) + Math.max(0, rawTotal - todo.subBaseline))
      : rawTotal;
  }

  const subTarget = isSubChallenge ? (todo.subGoal || 0) : 0;
  const goalMet = isSubChallenge && subCurrent >= subTarget;

  let status: TodoDisplayStatus = 'pending';
  if (todo.completed) {
    status = 'completed';
  } else if (isSubChallenge) {
    status = goalMet ? 'do_challenge' : 'waiting_subs';
  }

  return {
    isSubChallenge,
    subSource,
    subLabel,
    subCurrent,
    subTarget,
    goalMet,
    status,
  };
}

const STATUS_PRIORITY: Record<TodoDisplayStatus, number> = {
  do_challenge: 0,
  pending: 1,
  waiting_subs: 1,
  completed: 2,
};

/**
 * Returns a new array sorted with active "Goal Met -> Do Challenge!" items at the top,
 * active tasks & upcoming sub challenges in the middle, and completed items at the bottom.
 */
export function sortTodosForDisplay(
  todos: TodoItem[],
  settings: Partial<OverlaySettings>
): TodoItem[] {
  return [...todos].sort((a, b) => {
    const infoA = getTodoSubProgress(a, settings);
    const infoB = getTodoSubProgress(b, settings);
    const rankDiff = STATUS_PRIORITY[infoA.status] - STATUS_PRIORITY[infoB.status];
    if (rankDiff !== 0) return rankDiff;
    if (infoA.isSubChallenge && infoB.isSubChallenge && infoA.status === 'waiting_subs') {
      return infoA.subTarget - infoB.subTarget;
    }
    return 0;
  });
}
