import { Database } from "bun:sqlite";
import type { JudgmentState, Questions } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ChainJudge } from "../src/judgment";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/session/auth-storage";

// Hand-authored smoke corpus, not a representative quality or calibration benchmark.
// No credentials, session model, or remote fallback are loaded.
const selector = process.argv[2] ?? "local/qwen3-1.7b";
if (!selector.startsWith("local/")) throw new Error("This benchmark accepts only local models");
const settings = Settings.isolated({ modelRoles: { judge: selector }, "retry.fallbackChains": { judge: [] } });
const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
const registry = new ModelRegistry(auth, "/nonexistent/local-judge-benchmark.yml");
const judge = new ChainJudge({ settings, registry, purpose: "local-judge-benchmark" });

type Expected = Record<string, string | number>;
interface Case {
	id: string;
	state: JudgmentState;
	expected: Expected;
}
interface Group {
	name: string;
	questions: Questions;
	cases: Case[];
}

const completion = (id: string, state: string, status: string, verified: number, stage: number): Case => ({
	id,
	state,
	expected: { status, verified, stage },
});
const groups: Group[] = [
	{
		name: "completion",
		questions: {
			status: {
				type: "choice",
				instructions:
					"Is the requested task fully completed? Tests alone do not complete an outstanding deployment.",
				criteria: {
					done: "All requested work is complete and verified.",
					pending: "Any requested work or verification remains, is blocked, or failed.",
				},
			},
			verified: {
				type: "noul",
				instructions: "Does the report explicitly say verification of the implemented change succeeded?",
			},
			stage: {
				type: "score",
				instructions:
					"Choose the implementation stage, independently of whether deployment is requested or complete.",
				criteria: [
					"Implementation has not started.",
					"Implementation is incomplete or blocked.",
					"Implementation is complete but verification is missing or failed.",
					"Implementation is complete and verification succeeded.",
				],
			},
		},
		cases: [
			completion(
				"complete",
				"Implemented the feature, exercised the changed path successfully, and pushed the requested commit. No work remains.",
				"done",
				1,
				3,
			),
			completion("plan", "I have not started implementation. Next I will implement the fix.", "pending", 0, 0),
			completion(
				"blocked",
				"Implementation is halfway done. A missing required credential blocks the remaining work and verification.",
				"pending",
				0,
				1,
			),
			completion(
				"negation",
				"The implementation is not complete. Two call sites still need migration. No verification has run.",
				"pending",
				0,
				1,
			),
			completion(
				"failed",
				"Implementation is complete, but its smoke test failed. The task is not done.",
				"pending",
				0,
				2,
			),
			completion(
				"quoted",
				"The old log says 'all done', but the implementation is still running and has not been verified.",
				"pending",
				0,
				1,
			),
			completion(
				"verified",
				"All requested call sites are migrated. The live scenario passed. No deployment was requested and no work remains.",
				"done",
				1,
				3,
			),
			completion(
				"deployment",
				"Implementation is complete and its tests passed, but the user-requested deployment has not happened yet.",
				"pending",
				1,
				3,
			),
			completion("unverified", "Implementation is complete. Verification has not started.", "pending", 0, 2),
			completion(
				"not-started",
				"We agreed on a design. No implementation or verification has started.",
				"pending",
				0,
				0,
			),
			completion(
				"tests-old",
				"The old version's tests passed yesterday. Today's implementation is complete, but it has not been verified.",
				"pending",
				0,
				2,
			),
			completion(
				"scope",
				"The requested bug fix is implemented and its live regression passed. An unrelated optional feature was not requested and remains untouched.",
				"done",
				1,
				3,
			),
		],
	},
	{
		name: "relevance",
		questions: {
			match: {
				type: "choice",
				instructions:
					"Does this file implement the requested behavior? Incidental keyword mentions are insufficient.",
				criteria: {
					relevant: "Implements the requested behavior.",
					irrelevant: "Does not implement the requested behavior.",
				},
			},
			mutates: {
				type: "noul",
				instructions:
					"Does the described file change durable application state, rather than only reading or computing a result?",
			},
		},
		cases: [
			{
				id: "session-save",
				state: {
					query: "Persist sessions",
					file: "session-store.ts writes conversation records to SQLite and commits each transaction.",
				},
				expected: { match: "relevant", mutates: 1 },
			},
			{
				id: "session-read",
				state: {
					query: "Persist sessions",
					file: "session-list.ts reads existing conversation rows to render a list; it performs no writes.",
				},
				expected: { match: "irrelevant", mutates: 0 },
			},
			{
				id: "keyword",
				state: {
					query: "Refresh OAuth tokens",
					file: "theme.ts defines a color named tokenRefresh, without authentication or network behavior.",
				},
				expected: { match: "irrelevant", mutates: 0 },
			},
			{
				id: "refresh",
				state: {
					query: "Refresh OAuth tokens",
					file: "oauth.ts exchanges an expiring refresh token and atomically stores the returned credentials.",
				},
				expected: { match: "relevant", mutates: 1 },
			},
			{
				id: "parser",
				state: {
					query: "Parse retry deadlines",
					file: "retry-header.ts parses HTTP-date or numeric Retry-After values and returns a timestamp; it has no side effects.",
				},
				expected: { match: "relevant", mutates: 0 },
			},
			{
				id: "cooldown",
				state: {
					query: "Parse retry deadlines",
					file: "cooldown-store.ts accepts an already computed timestamp and saves it to disk; it does not parse headers.",
				},
				expected: { match: "irrelevant", mutates: 1 },
			},
			{
				id: "deny",
				state: {
					query: "Authorize model access",
					file: "permissions.ts compares requested models against client grants and returns allow or deny without writing state.",
				},
				expected: { match: "relevant", mutates: 0 },
			},
			{
				id: "catalog",
				state: {
					query: "Authorize model access",
					file: "catalog-sync.ts stores upstream model descriptions in SQLite but never checks client permissions.",
				},
				expected: { match: "irrelevant", mutates: 1 },
			},
		],
	},
	{
		name: "effort",
		questions: {
			effort: {
				type: "choice",
				instructions: "Classify the requested work's reasoning needs.",
				criteria: {
					low: "A direct factual answer or a fully specified mechanical edit.",
					high: "Nontrivial investigation, design, concurrency, or correctness tradeoffs.",
				},
			},
			design: {
				type: "noul",
				instructions:
					"Does the request require choosing or justifying a design, rather than following a fully specified change or returning a fact?",
			},
		},
		cases: [
			{ id: "arithmetic", state: "What is 2 + 2?", expected: { effort: "low", design: 0 } },
			{
				id: "rename",
				state: "Change the README heading from Setup to Installation. Make no other edits.",
				expected: { effort: "low", design: 0 },
			},
			{
				id: "constant",
				state: "Change the existing timeout constant from 30 to 45 seconds; no other behavior changes.",
				expected: { effort: "low", design: 0 },
			},
			{
				id: "format",
				state: "Convert the supplied list of three names to a JSON array; preserve their order.",
				expected: { effort: "low", design: 0 },
			},
			{
				id: "storage",
				state: "Design a crash-consistent concurrent storage engine and justify its recovery invariants.",
				expected: { effort: "high", design: 1 },
			},
			{
				id: "deadlock",
				state: "Investigate an intermittent deadlock without a reproduction, choose a fix, and explain why it cannot lose updates.",
				expected: { effort: "high", design: 1 },
			},
			{
				id: "migration",
				state: "Choose a zero-downtime schema migration plan for independently deployed old and new clients; assess rollback.",
				expected: { effort: "high", design: 1 },
			},
			{
				id: "auth",
				state: "Design tenant isolation for a shared inference gateway, including authorization boundaries and credential rotation.",
				expected: { effort: "high", design: 1 },
			},
		],
	},
];

const rows: {
	group: string;
	id: string;
	ms: number;
	correct: number;
	total: number;
	error?: string;
	actual?: Expected;
	expected: Expected;
}[] = [];
const started = performance.now();
try {
	for (const group of groups) {
		for (const sample of group.cases) {
			const before = performance.now();
			const total = Object.keys(sample.expected).length;
			try {
				const result = await judge.judge({ state: sample.state, questions: group.questions });
				const actual: Expected = {};
				for (const [id, answer] of Object.entries(result.answers)) {
					if (answer.type === "choice") actual[id] = answer.choice;
					else if (answer.type === "noul") actual[id] = answer.noul;
					else if (answer.type === "score") actual[id] = answer.score;
				}
				const correct = Object.entries(sample.expected).filter(([id, value]) => actual[id] === value).length;
				rows.push({
					group: group.name,
					id: sample.id,
					ms: performance.now() - before,
					correct,
					total,
					actual,
					expected: sample.expected,
				});
			} catch (error) {
				rows.push({
					group: group.name,
					id: sample.id,
					ms: performance.now() - before,
					correct: 0,
					total,
					expected: sample.expected,
					error: String(error),
				});
			}
			console.log(JSON.stringify(rows.at(-1)));
		}
	}
	console.log(
		JSON.stringify({
			model: selector,
			backend: process.env.PI_TINY_DEVICE ?? "default",
			cases: rows.length,
			correct: rows.reduce((sum, row) => sum + row.correct, 0),
			answers: rows.reduce((sum, row) => sum + row.total, 0),
			errors: rows.filter(row => row.error).length,
			elapsedMs: performance.now() - started,
			groups: groups.map(group => ({
				name: group.name,
				correct: rows.filter(row => row.group === group.name).reduce((sum, row) => sum + row.correct, 0),
				total: rows.filter(row => row.group === group.name).reduce((sum, row) => sum + row.total, 0),
			})),
		}),
	);
} finally {
	auth.close();
}
