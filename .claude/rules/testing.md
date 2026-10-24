# Testing

- Every change must be programmatically tested. Write a new test or update an existing test, then run it.
- Tests are Vitest files: `tests/Unit/*.test.ts` and `tests/Feature/*.test.ts`. Shared helpers are in `tests/support/helpers.ts`.
- Call `useSolder()` in each `describe`. It resets the database (seeded with the test data unless `{ seed: false }`), config, cache, HTTP fakes, mail and the queue fake before every test.
- Use the helpers instead of manual setup: `actingAs(user)`, `admin()`, `makeUser(permissions)`, `client({ token })`, `agent()` for cookie-based sign-in flows, `flashed()`, `flashedErrors()`, `redirectPath()`, `lastView()`, `useModRepository()`, `makeArchive()`, `putModversionZip()`, `fakeFabricMeta()`, `binary()` for downloads.
- No test may reach the network: fake requests with `Http.fake({...})` (`src/support/http.ts`); `useModRepository()` also blocks stray requests. Record queued jobs with `Queue.fake()` (`src/jobs/queue.ts`).
- Cover happy paths, failure paths, and edge cases.
- Do not remove tests or test files without approval.

## Running Tests

- Run the minimal number of tests using a file or name filter before finalizing; when they pass, ask the user about running the full suite.
- All tests: `pnpm test`
- Single file: `pnpm test tests/Feature/build-health.test.ts`
- Specific test: `pnpm test -t "reports a missing mod loader"`
- In the dev containers: `docker compose -f compose.dev.yml exec -T solder pnpm test`
