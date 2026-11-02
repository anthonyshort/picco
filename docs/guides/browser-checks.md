# Run bounded browser checks

The browser-check plugin answers one concrete question using an existing Atlas workflow. It does not review a whole application, make UX recommendations or publish comments. Its caller chooses the question and owns any publication.

Start with the [package example](../../packages/plugin-browser-checks/README.md). Configure a Pi model, an Atlas workflow the host may execute and read, and a profile describing allowed origins, authentication and disposable fixtures. Keep configuration and credentials outside source control.

## Prepare, run and assess

The plugin creates an ordinary Picco session for each job. The first turn prepares a bounded scenario. Host code launches Atlas and polls it without keeping a model turn active. A second turn inspects downloaded images and records a supported, contradicted or inconclusive answer. The plugin then closes the session.

Only the profile's explicitly supplied read tools and the plugin's own result tools are available through the host bridge. Other Picco sessions retain their existing access. The host must also scope the sandbox environment, mounted files, Pi extensions and credentials: restricting host tools alone does not restrict shell access.

The plugin runs one job at a time. The default five-minute deadline includes queueing, preparation, Atlas execution and evidence collection. `timeoutMs` may shorten that deadline. Screenshots are the default. Request video only when motion or timing is needed to answer the question.

Use an existing preview and disposable data. Apparently observational workbook interactions can autosave. Neither the supervisor nor Atlas should create a deployment, edit shared fixtures or publish evidence independently.

## Supply an Atlas tester

The operator supplies an existing executable Atlas workflow. The plugin sends the saved request, prepared plan, environment instructions, absolute deadline and result contract as its payload. Set `atlas.resultNode` when its result node is not named `tester`. Exactly one result from that node is accepted; an ambiguous result is an execution error.

The node must return JSON matching the exported `BrowserEvidenceSchema`: target URL, deployed revision and its proof, observations, limits, and prepared screenshot/video resource URLs. When a commit was requested, missing or mismatched revision proof blocks the answer.

The host downloads evidence only from the configured Atlas origin, using its configured token, with no redirects or copied browser cookies. It accepts PNG, JPEG and WebP screenshots and short MP4 recordings, at most 25 MB per file. Video verification requires host `ffprobe` and `ffmpeg`; the supervisor inspects sampled frames before answering. Inaccessible or invalid files become explicit coverage limits. Without any retrievable images, the job is blocked rather than claiming verification.

Atlas execution and media access are separate capabilities. Some attachment routes require a browser session rather than API-token access, and execution-zone restrictions also apply. Prove launch, result access and media retrieval in the pilot before enabling automatic use. A sandbox path or private Atlas link is not proof that evidence was delivered to the intended audience.

## Track jobs and updates

Application code can use `browser.checks.start`, `status` and `cancel`. Sessions use `browser_check_start`, `browser_check_status` and `browser_check_cancel`; configure their permitted plugin source names with `allowedSources`. Host code may inspect all jobs; a session may inspect only jobs it owns. The plugin never accepts a publishing destination or callback URL from model input.

Reuse a request key for the same submission. The plugin returns the saved job instead of launching it again. Different instructions under an existing key are rejected.

Job snapshots are stored in the plugin's private SQLite database. An exclusive store lock prevents two dispatchers from opening the same database. Status reads do not launch work.

`onUpdate(job, signal)` receives saved snapshots with increasing version numbers. Resolve only after saving the update in your application. Deduplicate by job ID and version, ignoring older versions. Respect the cancellation signal; a timed-out callback may otherwise complete after a later delivery. Failed delivery retries with increasing delays, at most once per minute. Updates can skip intermediate progress states. Delivering a result never repeats browser actions, and it need not wait for GitHub or another publishing service.

## Stop and recover

Cancellation stops local supervision and requests Atlas cancellation. Inspect `remoteStopped`: a cancellation response alone does not prove remote work ended. Valid partial evidence remains in the saved job.

Shutdown preserves known Atlas identities. After restart, the plugin reads those runs under their original deadlines. It does not repeat browser actions or silently restart interrupted preparation. Uncertain launches retain the same dispatch key and payload. Changed environment/workflow configuration prevents automatic continuation. An expired deadline does not permit relaunching an uncertain task.

The plugin keeps results and callback acknowledgements across restarts. Its database and evidence files are private local data. Retention, sharing and any later comment updates belong to the host application.
