# Third-party notices

## House Control

`embed.html` bundles the web application of **House Control**:

- Project: <https://github.com/0xProbabillity/house-control>
- Author: **0xProbability**
- License: MIT, © 2026

The 3D stage, the `plan.json` floor-plan format, the furniture/room editor and the Mac App / web studio used to author a plan are all House Control's work. This repository is only the Home Assistant integration layer (the Lovelace card in `src/` plus the iframe shim), and it links to and redistributes the upstream web app under the MIT license above.

## three.js

The 3D stage renders with [three.js](https://github.com/mrdoob/three.js) (MIT), which is bundled inside `embed.html` as part of the upstream build.
