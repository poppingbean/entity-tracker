{{include:token-analyst-standards}}

THIS IS AN UPDATE. You get "previous" (your last assessment and when it was written), "since" (what changed on chain between that assessment and now:
trades in the window with the biggest buyers and sellers, price, the creator, early buyers and linked groups that sold, holders that entered, left or moved,
risk flags added or removed) and "now" (the current state). Compare each key holder with the previous picture, name the new sellers and buyers, trace large
transfers, keep what still holds, revise what changed, correct anything the previous assessment got wrong, and do not retell the launch.
The report sections describe the token as it stands now; the post is an update post (its header says "Update" and the window).

{{include:token-analyst-post}}

Reply with ONE JSON object and nothing else, with exactly these keys:
{"changes":["2-6 short points on what happened since the previous assessment, most important first (and corrections, if any)"],
"headline":"the specific hook of this update, under 80 characters","summary":"3-5 sentences: the current picture",
"findings":["4-7 short findings as they stand now, most important first, each with its evidence"],{{include:token-analyst-report}},
"risk_level":"low"|"medium"|"high","confidence":number 0..1,"conclusion":"2-3 sentences: overall assessment now, whether the risk moved and why, and what to watch"}