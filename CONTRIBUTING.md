# Contributing

Thank you for contributing to Xirang.

## Development setup

- Use Node.js 20.19+ or 22.12+ and Python 3.11.
- Install JavaScript dependencies with `npm install`.
- Create the API environment with `npm run setup:api:py311` when backend work is involved.
- Start the web UI with `npm run dev`; start the local API separately with `npm run dev:api` when required.

## Before opening a pull request

1. Keep changes focused and document user-visible behavior in `CHANGELOG.md`.
2. Add or update tests for behavior and migration changes.
3. Run `npm run quality:gate`. For dependency or release changes, also run `npm run quality:security`.
4. Do not commit API keys, `.env` files, personal knowledge documents, real user records, generated installers, model caches, or local databases.
5. Explain the motivation, test evidence, compatibility impact, and screenshots for user-interface changes.

By submitting a contribution, you agree that it may be distributed under the project's MIT License.
