# Vendored Li³ web runtime

`li3-web.js` is the Rollup ESM build of `@li3/web` from Lithium commit
[`e36e0c438da7636f09550db34ff66b5612076eb5`](https://github.com/apphorde/lithium/tree/e36e0c438da7636f09550db34ff66b5612076eb5/lib/web).
The published npm package `@li3/web@0.2.41` does not yet contain the documented
`codePlan` feature. This source build is pinned here so OpenVoice can use Li³'s
blob-based code plan without permitting `unsafe-eval` in its Content Security
Policy. The Lithium project declares MIT licensing.

To refresh the bundle, build `lib/web/src/index.ts` from that exact Lithium
revision with its Rollup configuration, then replace this file. Verify the
`codePlan` flag remains present and run the CSP-backed Playwright suite before
updating the pin.
