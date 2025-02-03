import puppeteer from "puppeteer";
import http from "http";
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
//import neon from "@neondatabase/serverless";
import * as fs from "fs";
import { setTimeout } from "node:timers/promises";

const COOKIE_PATH = "cookies.json";
const UNTAPPD_URL = "https://untappd.com/user/ryan_milkiewicz/beers";

(async () => {
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  try {
    if (fs.existsSync(COOKIE_PATH)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf8"));
      await page.setCookie(...cookies);
      console.log("Loaded session cookies");
    }

    await page.goto(UNTAPPD_URL, { waitUntil: "networkidle2" });

    if ((await page.$('a[href*="login"]')) !== null) {
      console.log("Session expired. Please log in manually.");
      await page.goto("https://untappd.com/login", {
        waitUntil: "networkidle2",
      });

      console.log("Log in manually with Apple ID, then press ENTER here...");
      await new Promise((resolve) => process.stdin.once("data", resolve));

      const cookies = await page.cookies();
      fs.writeFileSync(COOKIE_PATH, JSON.stringify(cookies, null, 2));
      console.log("Session saved! Next time, login will be skipped.");
    } else {
      console.log("Already logged in!");
    }

    // Keep clicking "Show More" until all beers load
    let beerCount = 0;
    while (true) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await setTimeout(1000);

      // Find "Show More" dynamically
      const showMoreButton = await page.evaluateHandle(() => {
        return [...document.querySelectorAll("a")].find((btn) =>
          btn.innerText.includes("Show More")
        );
      });

      if (showMoreButton) {
        console.log("Clicking 'Show More' button...");
        await showMoreButton.evaluate((btn) => btn.scrollIntoView());
        await setTimeout(1000);
        await showMoreButton.click();
        await setTimeout(1000); // Wait for beers to load
      } else {
        console.log("No more beers to load.");
        break;
      }

      // Check if new beers loaded
      const newBeerCount = await page.evaluate(
        () => document.querySelectorAll(".beer-item").length
      );
      if (newBeerCount === beerCount) break;
      beerCount = newBeerCount;
    }

    // Scrape the beers
    const beers = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".beer-item")).map(
        (beer) => ({
          name: beer.querySelector(".name")?.innerText.trim(),
          brewery: beer.querySelector(".brewery")?.innerText.trim(),
          rating: (() => {
            const text =
              beer.querySelector(".ratings .you")?.innerText.trim() || "N/A";
            const match = text.match(/\((\d+(\.\d+)?)\)/); // Extracts the number inside parentheses
            return match ? match[1] : "N/A"; // Returns just the rating number
          })(),
          style: beer.querySelector(".style")?.innerText.trim() || "N/A",
          abv: beer.querySelector(".abv")?.innerText.trim() || "N/A",
          total_checkins: (() => {
            const text =
              beer.querySelector(".details .check-ins")?.innerText.trim() ||
              "N/A";
            const match = text.match(/\d+/); // Extracts the number
            return match ? match[0] : "N/A";
          })(),
        })
      );
    });

    console.log(`Total Beers Scraped: ${beers.length}`);
    fs.writeFileSync("beers.json", JSON.stringify(beers, null, 2));
    console.log("Beers saved to beers.json");

    // call stored procedure to merge beer data into database
    await importBeerData(beers);
    console.log("Data Import Complete!");
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await browser.close();
  }
})();

async function importBeerData(beers) {
  const sql = neon(process.env.DATABASE_URL);

  beers.forEach(async (beer) => {
    try {
      // Set statement_timeout for the current query (e.g., 30 seconds)
      await sql`SET statement_timeout = '10000000000000'`;

      // Calling the stored procedure with parameters
      await sql`CALL merge_beer_log(${beer.name}, ${beer.brewery}, ${beer.rating}, ${beer.style}, ${beer.abv}, ${beer.totalCheckins})`;
      console.log(`${beer.name} log merged successfully`);
    } catch (err) {
      console.error("Error calling the stored procedure:", err);
    }
  });
}
