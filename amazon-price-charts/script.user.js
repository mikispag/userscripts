// ==UserScript==
// @name           Amazon CamelCamelCamel + Keepa Price Charts
// @version        1.0.3
// @description    Add a CamelCamelCamel and Keepa price charts to Amazon product pages.
// @author         miki.it
// @namespace      null
// @homepage       https://github.com/mikispag/userscripts/
// @include        https://www.amazon.*/*
// @include        https://smile.amazon.*/*
// ==/UserScript==

var tld = document.domain.split(".").pop();
var country = tld;
if (tld == "com") {
    country = "us";
}

var asinElement = document.getElementById("ASIN");
if (!asinElement) {
    throw new Error("Amazon CamelCamelCamel + Keepa Price Charts: unable to get ASIN!");
}
var asin = asinElement.value;

var parentElement = document.getElementById("unifiedPrice_feature_div");
if (!parentElement) {
    throw new Error("Amazon CamelCamelCamel + Keepa Price Charts: unable to get parent element!");
}

var camelChartContainer = document.createElement("div");
var camelLink = document.createElement("a");
camelLink.target = "_blank";
camelLink.href = "https://" + country + ".camelcamelcamel.com/product/" + asin;
var camelChart = new Image(600, 250);
camelChart.src = "https://charts.camelcamelcamel.com/" + country + "/" + asin + "/amazon-new-used.png?force=1&zero=0&w=600&h=250&desired=false&legend=1&ilt=1&tp=all&fo=0";
camelLink.appendChild(camelChart);
camelChartContainer.appendChild(camelLink);

var keepaChartContainer = document.createElement("div");
var keepaLink = document.createElement("a");
keepaLink.target = "_blank";
keepaLink.href = "https://keepa.com/#!product/8-" + asin;
var keepaChart = new Image(600, 250);
keepaChart.src = "https://graph.keepa.com/pricehistory.png?used=1&asin=" + asin + "&domain=" + tld;
keepaLink.appendChild(keepaChart);
keepaChartContainer.appendChild(keepaLink);

var chartsContainer = document.createElement("div");
chartsContainer.appendChild(camelChartContainer);
chartsContainer.appendChild(keepaChartContainer);
parentElement.appendChild(chartsContainer);