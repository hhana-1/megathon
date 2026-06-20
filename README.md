# Glim Demo

This is a zero-backend hackathon prototype for a women-safety app. It demonstrates:

- timed protection mode
- fake incoming calls
- safety response countdown
- emergency contact escalation
- contact-app alarm state
- private browser microphone buffering
- simulated cloud upload only after SOS escalation
- live-location fallback

## Run

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Demo Script

1. Press `Start walk`.
2. Wait for the check-in timer or press `Fake call`.
3. Press the green call button to show the fake companion call.
4. Repeat and press the red call button to trigger the safety countdown.
5. Let the countdown finish to notify contacts and upload the private audio buffer.
6. Use `Settings` to tune the timers, auto-recording, fake call, contact-app alarm, and disguise mode.

## Privacy Model In This Demo

- When walking mode starts, audio is buffered locally in browser memory.
- Pressing `I'm safe` stops recording and discards the local buffer.
- Nothing is uploaded during normal safe check-ins.
- If SOS/emergency escalation happens, buffered chunks and new chunks move into the simulated cloud stream.
- This demo has no real cloud endpoint; `Cloud stream` is only an on-screen simulation.

## Production Next Steps

- Replace simulated contact alerts with push notifications.
- Replace simulated cloud upload with Firebase Storage, Supabase Storage, or S3/R2.
- Store incident metadata in Firestore, Supabase Postgres, or D1.
- Use Twilio only if real SMS/calls are required.
- Review local recording, consent, privacy, and data-retention laws before launch.
