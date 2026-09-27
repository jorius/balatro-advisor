# Balatro Advisor

Watches `%APPDATA%\Balatro\<profile>\save.jkr`, scores every play with Balatro's own hand rules, and shows a live recommendation at http://127.0.0.1:8787.

    npm start                      # default profile from settings.jkr
    npm start -- --profile 2       # explicit profile
    npm start -- --host 0.0.0.0    # reachable from a phone on the LAN
    npm start -- --save path\to\save.jkr
    npm test

Scores card ranks, suits, hand types and Planet levels only. Jokers (except Four Fingers / Shortcut hand-detection rules), seals, editions and enhancements are not scored.
