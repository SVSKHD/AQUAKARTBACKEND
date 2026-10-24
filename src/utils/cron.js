// Minimal 5-field cron parser ("minute hour day-of-month month day-of-week")
// with IANA timezone support. Supports *, lists, ranges, steps, month/day
// names and the @hourly/@daily/@weekly/@monthly/@yearly macros.

const MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES, nameOffset: 0 },
];

const parseValue = (raw, field) => {
  const upper = raw.toUpperCase();
  const nameIndex = field.names?.indexOf(upper) ?? -1;
  if (nameIndex >= 0) return nameIndex + field.nameOffset;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${field.name} value "${raw}"`);
  }
  const value = Number(raw);
  if (value < field.min || value > field.max) {
    throw new Error(
      `${field.name} value ${value} must be between ${field.min} and ${field.max}`,
    );
  }
  return value;
};

const parseField = (expression, field) => {
  const values = new Set();
  for (const part of expression.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined || !rangePart) {
      throw new Error(`Invalid ${field.name} expression "${part}"`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid ${field.name} step "${stepPart}"`);
    }

    let start;
    let end;
    if (rangePart === "*") {
      start = field.min;
      end = field.max;
    } else if (rangePart.includes("-")) {
      const [from, to] = rangePart.split("-");
      start = parseValue(from, field);
      end = parseValue(to, field);
      if (start > end) {
        throw new Error(`Invalid ${field.name} range "${rangePart}"`);
      }
    } else {
      start = parseValue(rangePart, field);
      end = stepPart === undefined ? start : field.max;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
};

export const parseCron = (expression) => {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error("Cron expression is required");
  }
  const normalized = MACROS[expression.trim().toLowerCase()] || expression;
  const parts = normalized.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      "Cron expression must have 5 fields: minute hour day-of-month month day-of-week",
    );
  }

  const [minute, hour, dom, month, dow] = parts.map((part, index) =>
    parseField(part, FIELDS[index]),
  );
  // Both 0 and 7 mean Sunday.
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
};

const formatters = new Map();
const getFormatter = (timeZone) => {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }),
    );
  }
  return formatters.get(timeZone);
};

export const isValidTimeZone = (timeZone) => {
  try {
    getFormatter(timeZone);
    return true;
  } catch (_error) {
    return false;
  }
};

// Wall-clock time in `timeZone`, encoded as a UTC Date truncated to the minute.
const toWallClock = (date, timeZone) => {
  const parts = Object.fromEntries(
    getFormatter(timeZone)
      .formatToParts(date)
      .map(({ type, value }) => [type, Number(value)]),
  );
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute),
  );
};

const offsetAt = (date, timeZone) =>
  toWallClock(date, timeZone).getTime() -
  Math.floor(date.getTime() / 60000) * 60000;

const fromWallClock = (wall, timeZone) => {
  const guess = wall.getTime() - offsetAt(wall, timeZone);
  return new Date(wall.getTime() - offsetAt(new Date(guess), timeZone));
};

const dayMatches = (spec, wall) => {
  const domMatch = spec.dom.has(wall.getUTCDate());
  const dowMatch = spec.dow.has(wall.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
};

export const nextCronRun = (
  expression,
  from = new Date(),
  timeZone = "Asia/Kolkata",
) => {
  const spec =
    typeof expression === "string" ? parseCron(expression) : expression;
  const wall = toWallClock(new Date(from.getTime() + 60000), timeZone);

  for (let i = 0; i < 200000; i += 1) {
    if (!spec.month.has(wall.getUTCMonth() + 1)) {
      wall.setUTCMonth(wall.getUTCMonth() + 1, 1);
      wall.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(spec, wall)) {
      wall.setUTCDate(wall.getUTCDate() + 1);
      wall.setUTCHours(0, 0, 0, 0);
    } else if (!spec.hour.has(wall.getUTCHours())) {
      wall.setUTCHours(wall.getUTCHours() + 1, 0, 0, 0);
    } else if (!spec.minute.has(wall.getUTCMinutes())) {
      wall.setUTCMinutes(wall.getUTCMinutes() + 1, 0, 0);
    } else {
      const instant = fromWallClock(wall, timeZone);
      if (instant > from) return instant;
      wall.setUTCMinutes(wall.getUTCMinutes() + 1, 0, 0);
    }
  }
  // e.g. "0 0 30 2 *" (Feb 30) never fires.
  return null;
};

export const nextCronRuns = (expression, count = 5, from, timeZone) => {
  const spec = parseCron(expression);
  const runs = [];
  let cursor = from || new Date();
  for (let i = 0; i < count; i += 1) {
    const next = nextCronRun(spec, cursor, timeZone);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
};
