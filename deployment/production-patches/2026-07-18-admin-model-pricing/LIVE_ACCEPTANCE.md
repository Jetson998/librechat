# Live Acceptance

Date: 2026-07-18
Latest release commit: `f285083d7106db3f2002c9a9476de1c1535e777c`

## Passed

- `/pricing` loads in the signed-in Admin Panel;
- both `MuskAPI` and `MuskAPI-Anthropic` are listed;
- GPT and Fable model selection and four price inputs render correctly;
- client validation and save preview show the intended four numeric prices;
- the original `endpoints.custom: Required` validation error is removed;
- the Admin Panel image is `librechat-admin-panel-model-pricing:5da05ef0635e`;
- Admin Panel health is healthy and protected neighboring container IDs did
  not change during its deployment.

## Remaining Blocker

Saving `gpt-5.6-sol` advances the base config version but leaves its
`tokenConfig` empty. The model key contains periods. The ordinary Mongoose
config-field update path does not preserve that dynamic dotted key inside the
tokenConfig object.

The approved GPT values are therefore not active yet. No historical
transactions were changed, and the UI must not be reported as fully accepted
until the API config writer uses a raw Mongo-safe write for tokenConfig model
keys containing periods.
