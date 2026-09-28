# Call script — Davis Mechanical Contractors AI Receptionist

## Opening (business hours, 8am–5pm)
> "Thanks for calling Davis Mechanical Contractors. Are you calling about a
> new service request, an existing appointment, or something else?"

## Opening (after hours)
> "Thanks for calling Davis Mechanical Contractors. You've reached us after
> hours, but I can still help you. Are you calling about a new service request,
> an existing appointment, or something else?"

## New service request
1. "Great, I can help with that. What's your name?"
2. "Thanks {name}. What's the best callback number? Or just say 'use my caller ID'."
3. "And briefly, what's the issue and what's the service address?"
4. *Caller gets:* text with the Housecall Pro booking link.
   *Owner gets:* `New service request — {name} ({phone}): {issue + address}`
5. "Thanks {name}. I've passed your information along and someone will call you
   back. I also just texted you our online booking link. Goodbye."

## Emergency (gas smell / leak / smoke / flooding)
> "I understand this is urgent. If you smell gas, please hang up right now,
> leave the building, and call your gas company or 911. Otherwise I'll flag
> this as a priority."
Then the same 3 questions as a service request; the owner alert is prefixed
**EMERGENCY (priority)**.

## Existing appointment
> "Got it. Please say your name and tell me briefly what's going on with your
> appointment."
*Owner gets:* `New existing appointment — {transcript}`

## Anything else / silence
> "Please say your name and your message, and we'll call you back."
*Owner gets:* `New message — {transcript}`

## SMS auto-reply (someone texts the Twilio number)
> "Thanks for texting Davis Mechanical Contractors! Book online here:
> {booking link} — or just reply and we'll call you back."
