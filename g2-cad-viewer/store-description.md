View and design 3D CAD parts on your G2 glasses.

Open a CAD or 3D file on your phone and the glasses show a crisp hidden-line view you can rotate, tilt, zoom, step through part by part, isolate and explode, all from the touchpad or by voice.

Supported files: STEP / IGES / BREP (full solid models and assemblies), DWG / DXF (AutoCAD drawings, one part per layer), and GLB, STL, OBJ, PLY, 3MF and FBX meshes.

AI design (optional): say or type "design a 60 mm L-bracket with two M5 holes", then "make it thicker". Claude writes the part as OpenSCAD code, and your phone turns it into a 3D model. Every design is saved in My designs on your phone, and any model can be exported as STL. This uses your own Claude API key through your own Cloudflare Worker; setup takes about 20 minutes.

Voice commands (optional): "rotate left 90", "top view", "zoom in", "wireframe", "next part", "isolate", "explode", "full screen", "turntable". Works with ElevenLabs or Deepgram speech-to-text, using your own account.

Privacy: the app contains no keys. Each user enters their own in Settings, stored only on their phone. Files are processed on your phone. Only AI design requests and voice audio are sent, to the services you configure.

Glasses controls: tap = next mode · swipe = adjust · hold = talk (push-to-talk) · double-tap = exit. Spoken designs ask you to confirm first (tap = go, swipe = cancel).

Licence: free software under the GNU GPL v3. It is built on GPL software: LibreDWG (GPL-3.0) for DWG/DXF and OpenSCAD (GPL-2.0+) for AI designs, plus three.js (MIT) and OpenCascade via occt-import-js (LGPL-2.1).

Source code (GPL-3.0): https://github.com/M4k10HREM/g2-cad-viewer
