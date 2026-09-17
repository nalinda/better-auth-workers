<!-- dev-harness: sections the story workflow reads. Fill in the table. -->

## Tests that ship with a change

Decide the kind of test _before_ handing a sub-task to an implementing agent,
and say so in the run note. Left to itself an agent reaches for unit tests
beside the source even when the risk lives elsewhere.

| What the sub-task touches                                             | What to ask for                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Pure functions, helpers, data modules                                 | unit tests beside the source, covering failure paths and boundaries                 |
| API routes                                                            | route tests driving the real app object, asserting status **and** body              |
| Schema, migrations, seeders — behaviour only visible by executing SQL | a check under the database test directory, wired as a script the verify ladder runs |
| A user-facing flow the browser suite already covers                   | update those specs; add a new one only if the flow is genuinely new                 |
| Rename, comment, inert config, generated-file move                    | none — say so explicitly                                                            |

Be concrete about the invariant, not the mechanism. "Assert that a filterable
property must be an enum" produces a test that can fail; "add unit tests"
produces one that cannot.

## Issue and story rules

- A sub-task PR uses `Closes #<sub-task>` and **never** a closing keyword on the
  parent story — that would close a story with sub-tasks still open.
- A story issue stays open until every sub-task is merged.
- The story PR into the default branch may use `Closes #<story>`.

## Running sub-tasks concurrently

The harness has no opinion on this and no config key for it, because the answer
depends on the repo and sometimes on the story. State it here; the orchestrator
reads this file.

Fill in whichever is true:

- **Serialised.** Sub-tasks share one local database instance and fixed
  dev-server ports, so exactly one `task-run.sh` at a time.
- **Concurrent is fine.** Sub-tasks touch independent packages and the
  verification ladder does not bind a port. Up to N at once.
- **Per-story.** Say so on the story issue when its sub-tasks conflict.

Every runner records its own session or conversation id, so sub-tasks may
overlap on any of them when this file says they can.
