import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run check:commit -- <commit-message-file-or-subject>");
  process.exit(2);
}

let message = input;
try {
  await access(input, constants.F_OK);
  message = await readFile(input, "utf8");
} catch {
  // Treat the argument as a subject for quick local checks.
}

const lines = message.replace(/\r/g, "").split("\n").filter((line) => !line.startsWith("#"));
const subject = lines[0]?.trim() || "";
const subjectPattern = /^(feat|fix|refactor|docs|test|chore|arch|security|perf)(\([a-z0-9._-]+\))?: .{1,60}$/;
if (!subjectPattern.test(subject) || subject.length > 72) {
  console.error("Invalid commit subject. Expected: <type>(<scope>): <imperative summary>, max 72 chars.");
  process.exit(1);
}

const body = lines.slice(1).join("\n");
for (const field of ["Intent:", "Changes:", "Verification:", "Risks:", "History:"]) {
  if (!body.includes(field)) {
    console.error(`Commit body is missing required field: ${field}`);
    process.exit(1);
  }
}
console.log("Commit message OK.");
