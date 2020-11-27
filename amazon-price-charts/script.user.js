// ==UserScript==
// @name            Amazon CamelCamelCamel + Keepa Price Charts
// @version         1.0.6
// @description     Add a CamelCamelCamel and Keepa price charts to Amazon product pages.
// @author          miki.it
// @namespace       null
// @homepage        https://github.com/mikispag/userscripts/
// @include         https://www.amazon.*/*
// @include         https://smile.amazon.*/*
// ==/UserScript==

function getASIN() {
    var asinElement = document.getElementById("ASIN") || document.evaluate("//@data-asin", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    if (!asinElement) {
        throw new Error("Amazon CamelCamelCamel + Keepa Price Charts: unable to find ASIN!");
    }
    return asinElement.value;
}

window.addEventListener("load", function() {
    var tld = document.domain.split(".").pop();
    var country = tld;
    if (tld == "com") {
        country = "us";
    }

    var asin = getASIN();
    if (!asin) {
        throw new Error("Amazon CamelCamelCamel + Keepa Price Charts: unable to get ASIN!");
    }

    var parentElement = document.getElementById("unifiedPrice_feature_div") || document.getElementById("MediaMatrix");
    if (!parentElement) {
        throw new Error("Amazon CamelCamelCamel + Keepa Price Charts: unable to get parent element!");
    }

    var camelChartContainer = document.createElement("div");
    var camelLink = document.createElement("a");
    camelLink.target = "_blank";
    camelLink.href = "https://" + country + ".camelcamelcamel.com/product/" + asin;
    var camelChart = new Image(500, 400);
    camelChart.src = "https://charts.camelcamelcamel.com/" + country + "/" + asin + "/amazon-new-used.png?force=1&zero=0&w=500&h=400&desired=false&legend=1&ilt=1&tp=all&fo=0";
    camelLink.appendChild(camelChart);
    camelChartContainer.appendChild(camelLink);

    var keepaChartContainer = document.createElement("div");
    var keepaLink = document.createElement("a");
    keepaLink.target = "_blank";
    keepaLink.href = "https://keepa.com/#!product/8-" + asin;
    var keepaChart = new Image(500, 200);
    keepaChart.src = "https://graph.keepa.com/pricehistory.png?used=1&asin=" + asin + "&domain=" + tld;
    keepaLink.appendChild(keepaChart);
    keepaChartContainer.appendChild(keepaLink);

    var chartsContainer = document.createElement("div");
    chartsContainer.appendChild(camelChartContainer);
    chartsContainer.appendChild(keepaChartContainer);
    parentElement.appendChild(chartsContainer);
}, false);