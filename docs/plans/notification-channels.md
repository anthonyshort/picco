# Notification channel delivery sequence

The owner approved upstream API work, including restart-safe tracking, split into focused draft PRs. The current review skill, runner, consumer configuration and running services stay unchanged.

1. Broadcast and editable logical messages: retain directed sends; add scoped `messageKey` calls, independent channel receipts, serial edits, uncertainty handling and host-owned routing.
2. Restart-safe tracking: persist recipient-bound handles and reserve attempts before transport. Preserve uncertain writes instead of automatically replaying them.
3. Telegram adapter: stable chat identity and edits without starting a poller.
4. GitHub adapter: fixed authorised PR, Markdown comment create/update, validated comment membership and no gateway requirement.

The adapter PRs depend on the shared contract, while persistence can be reviewed independently above the broadcast base. Each commit requires full `pnpm validate`. Live consumer adoption and workflow integration are separate future work.
