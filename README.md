# Userscripts

A collection of userscripts I maintain for personal use, published in case they
are useful to others. Compatible with [Violentmonkey](https://violentmonkey.github.io/),
[Tampermonkey](https://www.tampermonkey.net/), and
[Greasemonkey](https://www.greasespot.net/).

## Prerequisites

Install a userscript manager extension in your browser before using any of
these scripts:

- [Violentmonkey](https://violentmonkey.github.io/) (recommended, open source)
- [Tampermonkey](https://www.tampermonkey.net/)
- [Greasemonkey](https://www.greasespot.net/) (Firefox only)

## Scripts

### Monerio + Rabattcorner + iGraal Cashback

Surfaces cashback availability from [Monerio](https://monerio.ch/),
[Rabattcorner](https://www.rabattcorner.ch/), and [iGraal](https://www.igraal.com/)
on the shops you actually visit. When more than one provider covers the same
shop, the best offer is highlighted. Coupon codes and one-click affiliate
activation links are included.

Runs on every site (`https://*/*`) and lazily queries the providers' public
APIs only for the current domain. Excludes social and search domains. Results
are cached locally (TTLs from hours to days) to minimize requests.

**Install:**

- [Directly from this repository](https://github.com/mikispag/userscripts/raw/main/monerio-rabattcorner-igraal/monerio-rabattcorner-igraal-cashback.user.js)

> **Privacy note:** like the official iGraal browser extension, this script
> sends one GraphQL request per unique host you visit so it can determine
> whether that retailer is on iGraal. Negative lookups are cached for 30 days
> and positive ones for 14 days.

## Updates

Scripts installed from Greasy Fork update automatically. Scripts installed
directly from this repository update via the `@downloadURL` / `@updateURL`
metadata when configured; otherwise re-install from the raw GitHub URL to
pick up new versions.

## Contributing

Issues and pull requests are welcome at
<https://github.com/mikispag/userscripts>. Each script lives in its own
subdirectory with a single `*.user.js` entry point.

## License

[MIT](LICENSE) © Michele Spagnuolo
