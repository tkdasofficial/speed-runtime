# speed-runtime

Build runtime for Speed. The Speed API dispatches `build.yml` with a single-use token; the run fetches one
generated React + TypeScript + Vite project, builds it in a temporary workspace (`$RUNNER_TEMP/workspace/{userId}/{projectId}`),
posts the static output back, and deletes the workspace. Generated projects are never committed here — persistent
source and static output live in Speed's storage.
