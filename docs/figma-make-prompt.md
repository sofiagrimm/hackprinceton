# Figma Make prompt: Encore Scout

Paste everything below the line into Figma Make.

---

Design a single-page web app called **Encore Scout**, in the style of an Apple product page (apple.com/iphone or apple.com/airpods-pro): one idea per screen, huge confident type, generous white space, an immersive product hero, and almost no interface chrome.

## What the product is
Encore Scout is an AI location scout for touring performers: a cappella groups and choirs first, film crews later. A tour manager types a brief like "14 singers touring LA on March 14. A show for 80 guests, 2 nights, same building if we can." The agent searches 3,288 real buildings in Los Angeles and Houston that have Matterport 3D scans, measures how each room will sound (its reverberation time, RT60, in seconds), checks the building from the air (Vexcel aerial imagery), finds lodging nearby, checks the group's bank balance, and drafts the email to the venue. The emotional promise: "Hear the room before you book it."

## Visual direction
- Apple's system type (SF Pro Display / SF Pro Text). Headlines 80 to 96px, semibold, tight tracking. Body 17px. Big numbers set in type, never in boxes.
- Colour: black and white, with #f5f5f7 for alternate sections. Blue #0071e3 only for things you can press (one pill button per screen, text links). One brand colour, a warm red #ff375f, used only inside the 3D visual for sound rings, never on UI.
- Depth comes from the 3D render and photography, not from shadows, gradients or cards.
- Sections alternate black and white, each a full-viewport "chapter".

## Do not use (these read as AI-generated)
No purple/blue gradients, no Inter, no glassmorphism cards, no rows of three rounded feature cards with icons, no emoji, no coloured eyebrow labels above every heading, no pill "chip" tags, no glowing buttons, no stat boxes, no bento grid, no stock illustrations, no "Powered by AI" badges, no generic fade-in on every element.

## Screens, top to bottom

1. **Sticky sub-nav** (52px, translucent black): "Encore Scout" on the left in 21px semibold; on the right, small grey links (Overview, Sound, Light, Inside, Stay, Budget) and one small blue pill button "Scout".

2. **Hero, pinned while you scroll (black).** Full-bleed 3D architectural model of a real building: a white, slightly glassy extruded tower standing on a square tile of real aerial photography, floating in black space, with real sun shadows across the street. Thin red contour lines mark each floor; soft red rings ripple out from its base like sound. Centered text on top: small "Encore Scout", then "Every room has a sound." very large, then grey "Find the one your group was made for." At the bottom, a wide dark translucent text field holding the brief, with a blue "Scout" pill inside it on the right, and below it a quiet line: "Try A cappella in LA · Rehearsal retreat · Choir concert · Film shoot" as blue text links.
   Show three more frames of the same pinned hero as the user scrolls; the camera orbits and pulls back, and the headline changes:
   - "3,288 buildings. Scanned inside and out."
   - "Measured in seconds of reverb." (the rings are prominent)
   - "Lit by the real sun." with "4:30pm in Los Angeles" (warm golden light, long shadows)

3. **The plan (white).** Heading "Scouting." and a thin vertical list of agent steps with a small dot each (grey, blue when live, black when done): Search scanned rooms, Measure the acoustics, Check the site from the air, Find somewhere to stay, Check the tour fund, Draft the ask. Each has a one-line grey result, e.g. "8 strong matches across 1,554 scanned buildings in Los Angeles."

4. **The pick (white).** Grey "The pick", then "3033 Wilshire" at display size, grey address. A row of four big typographic figures separated by hairlines: "1.68 sec" (green) "of reverb with a full house"; "252" "seats in the lobby"; "0.9 mi" "to Royal Viking Motel"; "$1,526" "for the group, 2 nights". A short paragraph of the agent's reasoning.

5. **Sound (black).** Centered "Hear it before you book it." Grey verdict: "Ideal for unamplified vocal ensemble performance: 1.7s sits inside the 1.3 to 2.0s target." Room names as text links. A large white circular play button. A small segmented control "Empty | Full house". Blue text links "Clap" and "Sing into the room". A thin blue waveform. A horizontal bar chart: grey bar "Empty 2.75s", blue bar "Full house 1.68s", over a faint green band labelled "Target 1.3 to 2.0s". A spec list (label left, value right, hairline rows): Room, Size, Reverb, Capacity, Assumed finishes.

6. **Light (#f5f5f7).** "See the light at showtime." A full-width 3D render of the building at golden hour with long shadows. Below it, a date field, a time slider and the time in bold. A two-column spec list: Sun "28° from the southwest", Sunrise, Golden hour, Sunset, Shadow length, Walls in sun; Parking (CoStar) "302 spaces", Footprint, Roof "flat, membrane", Building height.

7. **Inside (white).** "Step inside." A full-width 16:9 poster of the aerial photo, darkened, with a white play triangle and "Open the 3D tour". Below it, a line in large grey semibold: "You're in **the Club Lounge**, 5,232 sq ft. **1.31s** of reverb with a full house."

8. **Stay (white).** "Sleep close." A list, not cards: each row has the name and price in 21px semibold ("Royal Viking Motel" / "$1,526") and a grey line under it ("Hotel, 0.9 mi away. 7 rooms x $109/night x 2 nights.").

9. **Budget (#f5f5f7).** "Keep the tour solvent." A huge number "$1,976", then a green sentence "Fits the tour fund, with $524 to spare." A spec list: Tour fund available, Venue estimated, Lodging, Break-even ticket "$24.70", Each member's share "$141.14". A blue pill button "Hold the deposit and collect dues". Small grey note: "Planned by the scout, approved by the treasurer, settled in Capital One's Nessie sandbox."

10. **Reach out (white).** "Make the ask." The drafted email set like a letter (bold subject, grey "To Michael Pakravan, Matthews Real Estate", then the body), and a blue pill "Copy email".

11. **Other rooms (white).** "Other rooms worth a listen." A horizontal scrolling rail of large rounded photographs of buildings, each with a 21px name and a grey line like "Club Lounge. 1.24s, 436 seats."

12. **Footer (#f5f5f7).** Small grey legal-style text crediting CoStar, Matterport, Vexcel and Capital One Nessie.

## Also design
- A mobile version (390px wide) of the hero, the pick and the sound section.
- An iMessage conversation mock: the user texts the brief to the Encore Scout contact, and the reply shows the pick, the reverb, lodging and budget in a few short lines, then an aerial photo, then a link "Hear your group in this room".
- Light and dark mode for the white sections.
