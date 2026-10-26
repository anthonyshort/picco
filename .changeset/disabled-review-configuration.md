---
"@picco-agent/plugin-github-reviews": patch
---

Allow an unconfigured review plugin to start disabled with no repositories, keeping management tools available without calling GitHub. Export the settings schema so applications can validate configuration without copying its defaults and limits. Enabling reviews still requires at least one repository route.
