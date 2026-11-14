# Setting up the phone line

Someone calls a Photon number. Photon passes the call over SIP to a Retell voice agent. When the agent needs
a room, it calls our server, reads out a short answer and then texts the caller a link to hear the room.

```
caller -> Photon number -> SIP -> Retell agent -> POST /api/voice/retell/<function> -> scout
                                                      text_me_the_link -> Photon SMS -> caller
```

We picked Retell out of the four providers in Photon's voice cookbooks. Its custom functions are a plain
HTTPS POST that already carries the caller's number, so the server needs no SDK and no audio handling.
ElevenLabs would also work. Twilio and LiveKit would mean running the speech loop ourselves.

## What you need

- A Photon project (Beta, app.beta.photon.codes) with an **SMS number**. Shared iMessage lines can't take calls.
- A Retell account (retellai.com).
- The site deployed somewhere public, so Retell can reach it. That URL goes in `PUBLIC_URL`.

## 1. Add these to `.env` (and to the deploy's variables)

```
VOICE_WEBHOOK_TOKEN=<any long random string>
PHOTON_SMS_NUMBER=+1XXXXXXXXXX      # the Photon number people call, in E.164
PHOTON_API_KEY=...                  # already used by the iMessage line
PHOTON_PROJECT_ID=...
PUBLIC_URL=https://<your deploy>
```

To generate a token:

```bash
python -c "import secrets; print(secrets.token_urlsafe(24))"
```

## 2. Photon: create the Voice profile

These steps follow Photon's cookbook at photon.codes/docs/beta/cookbooks/voice/retell.

1. In your Photon project, open **Voice**. Your SMS number should be listed under **Lines**.
2. Under **Default profile**, choose **Set up default**, pick **SIP** and choose **Create profile**.
3. Leave **Media encryption** on **Auto**.
4. You only need **Outbound calls** if Retell should place calls. To set it up, pick **SHA-256** and choose
   **Enable outbound**. Save the password, because Photon shows it once. Then copy the **Username** and the
   **SIP connection** server (for example `sip.photon.codes`, with TLS on port 5061).

## 3. Retell: import the number

1. In Retell, go to **Deploy**, then **Phone Numbers**. Press **+** and choose **Connect to your number via
   SIP trunking**.
2. Fill in the form:
   - **Phone Number**: your Photon number with its country code.
   - **Termination URI**: the Photon SIP server from step 2, e.g. `sip.photon.codes:5061`.
   - **Outbound Transport**: TLS.
   - **SIP Trunk User Name** and **Password**: the Photon outbound credentials. Leave them blank for
     inbound only.
3. Press **Save**.

## 4. Retell: build the agent

Our server prints everything to paste. Run this once the site is deployed with the token:

```bash
curl "$PUBLIC_URL/api/voice/retell-config?token=$VOICE_WEBHOOK_TOKEN"
```

It returns `general_prompt`, `begin_message`, the four `functions` with their URLs filled in, and
`agent_webhook_url`.

1. Create a new agent using Retell's own LLM (single prompt). Paste `general_prompt` as the prompt and
   `begin_message` as the first thing the agent says.
2. Add four **Custom Functions**: `find_rooms`, `next_option`, `find_lodging` and `text_me_the_link`.
   For each one, copy the name, description, URL (method POST) and parameters JSON from the config output.
   Turn on "speak after execution". For `find_rooms`, also turn on "speak during execution", so the agent
   says "one moment" while it searches.
3. In the agent's settings, set the **webhook URL** to `agent_webhook_url`. If a call ends before the
   caller asked for the link, the server sends it anyway.
4. Publish the agent. On the imported number, set **Inbound Call Agent** to it.

The server accepts both payload shapes Retell can send: arguments under `args` (the default) or at the top
level ("args only").

## 5. Photon: send calls to Retell

1. Back in the Photon Voice profile, go to **Inbound calls** and choose **Enable inbound**.
2. Set **SIP address** to `sip:sip.retellai.com;transport=tls`. Photon rewrites it to `sips:sip.retellai.com`,
   and that's fine.
3. Leave the SIP username and password empty, then choose **Enable inbound**.

## 6. Texting the link

`text_me_the_link` texts the caller from your Photon number using Photon's API. It looks up both numbers as
SMS users, opens a space between them, then sends the message. US carriers need an approved **10DLC
campaign** before a number can text US phones. Photon's docs cover this under Messaging, SMS, 10DLC. Until
it's approved, the texts may not arrive, but the call itself still works.

## Testing without any accounts

```bash
python scripts/voice_sim.py
```

This plays a whole call: the caller's lines, which function the agent would call, and what it would say.
It sends the same JSON that Retell sends. Without Photon keys, the closing text is written to
`data/cache/voice_outbox.json` instead of being sent. Use `-i` to play the caller yourself, or pass a text
file with one caller line per line.

## Checking it's live

`GET /api/voice/status` shows whether the token and Photon texting are set up. A test call should show
POSTs to `/api/voice/retell/find_rooms` in the server log. If none show up, check Retell's **Call History**.

## What I couldn't verify

The Photon steps come from Photon's own Retell cookbook. Retell's docs were blocked from my session, so the
Retell field names in step 4 and the payload shape are from what I know of Retell, and I haven't checked
them against its current docs. If a label in Retell's dashboard is different, the values to paste are still
the ones in `/api/voice/retell-config`. No real call has been placed. Everything up to Retell's POST was
tested with the simulator.
