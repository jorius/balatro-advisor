# Balatro Advisor

Watches `%APPDATA%\Balatro\<profile>\save.jkr`, scores every play with Balatro's own hand rules, and shows a live recommendation at http://127.0.0.1:8787.

    npm start                      # default profile from settings.jkr
    npm start -- --profile 2       # explicit profile
    npm start -- --host 0.0.0.0    # reachable from a phone on the LAN
    npm start -- --save path\to\save.jkr
    npm test

Scoring includes jokers (with their live counters from the save), card enhancements, editions, seals, Planet levels and boss blind rules, via the vendored [Balatrolator](https://github.com/kleinfreund/balatrolator) engine (MIT, `vendor/balatrolator`). The exact score of every play is shown; the clear-probability lookahead estimates future hands from the current joker boost. Jokers the scorer cannot model (Driver's License, Space Joker, unknown mod jokers) are listed as warnings. After every real hand the status bar compares the predicted score with the chips the game actually added, so you can see whether the engine is trustworthy for your current jokers.

    npm start -- --card-only       # ranks, suits and hand levels only, no jokers

To refresh the joker name table after a game update: `node scripts/gen-joker-names.js <path to game.lua>` (extract `game.lua` from `Balatro.exe` with `unzip`).

## About the delay

Balatro queues a save after every play or discard but only writes it when its 5-second save timer has elapsed, at round end, or on pause. The advisor reacts within about 80 ms of the file landing, so any remaining lag is that timer. If you want it gone, the optional patch in `mods/BalatroAdvisor/lovely/save-timer.toml` makes the game flush saves immediately; it needs the Lovely injector, see the comments in that file.
