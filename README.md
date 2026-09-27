# Balatro Advisor

Watches `%APPDATA%\Balatro\<profile>\save.jkr`, scores every play with Balatro's own hand rules, and shows a live recommendation at http://127.0.0.1:8787.

    npm start                      # default profile from settings.jkr
    npm start -- --profile 2       # explicit profile
    npm start -- --host 0.0.0.0    # reachable from a phone on the LAN
    npm start -- --save path\to\save.jkr
    npm test

Scores card ranks, suits, hand types and Planet levels only. Jokers (except Four Fingers / Shortcut hand-detection rules), seals, editions and enhancements are not scored.

## About the delay

Balatro queues a save after every play or discard but only writes it when its 5-second save timer has elapsed, at round end, or on pause. The advisor reacts within about 80 ms of the file landing, so any remaining lag is that timer. If you want it gone, the optional patch in `mods/BalatroAdvisor/lovely/save-timer.toml` makes the game flush saves immediately; it needs the Lovely injector, see the comments in that file.
