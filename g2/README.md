# RiderKaki for Even Realities G2

Glanceable rain, free motorbike lots and live bus times on G2 smart glasses, from riderkaki.sg's live data.

- `src/screens.js`: what each glasses screen says (plain text, testable on its own)
- `src/main.js`: talks to the glasses through the Even Hub SDK, gets the phone location, fetches data
- `index.html`: the phone page (status, a copy of the glasses screen, and buttons to try it without glasses)
- `app.json`: Even Hub manifest (location + network to riderkaki.sg)

Built and hosted as its own Vercel project, riderkaki-glasses (root directory `g2`). The build also tries to make
`riderkaki.ehpk` (the Even Hub package) and puts it next to the app.

On the glasses: swipe to change screen, tap to refresh (on Bus: next nearest stop), double tap to close.
