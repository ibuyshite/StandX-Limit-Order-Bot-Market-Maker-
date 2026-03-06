class StandxLimitOrder {

    // ========== Configuration ========== 
    static CONFIG = {
        QUANTITY: 0.001,
        SYMBOL: 'btc-usd',
        BPS_LADDER: [8.5, 9.5, 10],
        REPLACEMENT_BPS: 8.5,
        MIN_DISTANCE_BPS: 3,      // Cancel order if BPS is smaller than this (to avoid execution)
        MAX_DISTANCE_BPS: 11,     // Cancel order if BPS is greater than this
        MAX_LOOPS: 0,             // Set to 0 or less for infinite loops
        USE_INDICATORS: true,
        ATR_CHANGE_THRESHOLD: 20.0,  // Skip new orders if ATR changes by more than this
        MAX_ATR: 220.0               // Max absolute ATR value to allow trading
    };

    // ========== DOM Element Selectors ========== 
    static SELECTORS = {
        ORDER_PRICE: 'td:nth-child(6) > div', 
        CANCEL_BUTTON: 'td:nth-child(10) > div > button', 
        POSITION_CLOSE_BUTTON: 'button',
        LIMIT_ORDER_BUTTON: 'button',
        PRICE_INPUT: 'input[placeholder="Price"]', 
        QUANTITY_INPUT: 'input[placeholder="Size"]', 
        BUY_BUTTON: 'button',
        SELL_BUTTON: 'button'
    };

    constructor() {
        this.loopInterval = null;
        this.loopCounter = 0;
        this.previousAtr = null;
    }

    async getIndicatorsFromChart() {
        const indicators = { atr: null, adx: null, rsi: null };
        
        // 1. Create a list of all documents to search (Top window + all iframes)
        const documents = [document];
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach(iframe => {
            try {
                if (iframe.contentDocument) {
                    documents.push(iframe.contentDocument);
                }
            } catch (e) {
                // Cross-origin iframes might throw an error; we skip those
            }
        });

        try {
            for (const doc of documents) {
                // Search for the legend items in this specific document
                const legendItems = doc.querySelectorAll('[class*="item-"][class*="study-"], [class*="legend-"] [class*="item-"]');
                
                if (legendItems.length > 0) {
                    legendItems.forEach(item => {
                        const text = item.textContent.trim().toUpperCase();
                        let key = '';
                        if (text.includes('ATR')) key = 'atr';
                        else if (text.includes('ADX')) key = 'adx';
                        else if (text.includes('RSI')) key = 'rsi';

                        if (key) {
                            const matches = text.match(/\d+\.\d+/g) || text.match(/\d+/g);
                            if (matches && matches.length > 0) {
                                let valStr = matches[matches.length - 1];
                                // Strip TradingView period (14) if it's mashed together
                                if (valStr.startsWith('14') && valStr.length > 4) {
                                    valStr = valStr.substring(2);
                                }
                                const num = parseFloat(valStr);
                                if (!isNaN(num)) indicators[key] = num;
                            }
                        }
                    });
                    // If we found indicators in this document, we don't need to check other iframes
                    if (indicators.atr || indicators.adx) break;
                }
            }
            return indicators;
        } catch (error) {
            console.error("Indicator Scraper Error:", error);
            return indicators;
        }
    }

    async getOpenOrders() {
        const tables = document.querySelectorAll('table');
        const openOrders = [];
        for (const table of tables) {
            const header = table.querySelector('thead');
            // The orders table has a unique set of headers.
            if (header && header.textContent.includes('Created At') && header.textContent.includes('Order Value')) {
                const orderRows = table.querySelectorAll('tbody tr');
                for (const row of orderRows) {
                    const longElement = row.querySelector('div.text-chart-up');
                    const shortElement = row.querySelector('div.text-chart-down');
                    const side = longElement ? 'long' : (shortElement ? 'short' : null);
                    if (!side) continue;

                    const priceElement = row.querySelector(StandxLimitOrder.SELECTORS.ORDER_PRICE);
                    const cancelButton = row.querySelector(StandxLimitOrder.SELECTORS.CANCEL_BUTTON);
                    if (priceElement && cancelButton) {
                        const price = parseFloat(priceElement.textContent.replace(/,/g, ''));
                        if (!isNaN(price)) {
                            openOrders.push({ side, price, cancelButton });
                        }
                    }
                }
                return openOrders; 
            }
        }
        return openOrders;
    }

    async getOpenPositions() {
        const tables = document.querySelectorAll('table');
        const openPositions = [];
        for (const table of tables) {
            const header = table.querySelector('thead');
            if (header && header.textContent.includes('P/L')) {
                const positionRows = table.querySelectorAll('tbody tr');
                for (const row of positionRows) {
                    let closeButton = null;
                    const buttons = row.querySelectorAll('button');
                    for (const button of buttons) {
                        if (button.textContent.trim().toLowerCase() === 'close') {
                            closeButton = button;
                            break;
                        }
                    }

                    let side = null;
                    const sideDivs = row.querySelectorAll('td:nth-child(2) div'); // 2nd column for Side
                    for (const div of sideDivs) {
                        const text = div.textContent.trim().toUpperCase();
                        if (text === 'LONG') {
                            side = 'long';
                            break;
                        } else if (text === 'SHORT') {
                            side = 'short';
                            break;
                        }
                    }

                    if (closeButton && side) {
                        openPositions.push({ side, closeButton });
                    }
                }
                break;
            }
        }
        return openPositions;
    }

    async closePosition(position) {
        if (!position || !position.closeButton || !position.side) {
            return;
        }

        try {
            console.log(`Closing ${position.side} position (Step 1/2)...`);
            position.closeButton.click();
            
            const dialog = await this.waitForElement('[role="dialog"]');
            if (!dialog) {
                console.error("Could not find the confirmation dialog after clicking close.");
                return;
            }

            console.log("Looking for confirmation button in dialog (Step 2/2)...");
            const confirmationSideText = position.side === 'long' ? 'SHORT' : 'LONG';
            
            let confirmButton = null;
            const allButtons = dialog.querySelectorAll('button'); // Search only within the dialog
            for (const button of allButtons) {
                if (button.textContent.trim().toUpperCase().includes(confirmationSideText)) {
                    confirmButton = button;
                    break;
                }
            }

            if (confirmButton) {
                console.log(`Found and clicking "${confirmationSideText}" confirmation button.`);
                confirmButton.click();
                await this.delay(500);
            } else {
                console.error(`Could not find the "${confirmationSideText}" confirmation button inside the dialog.`);
            }
        } catch (error) {
            console.error("An error occurred while trying to close a position:", error);
        }
    }

    async cancelOrder(order) {
        if (order && order.cancelButton) {
            console.log(`Canceling ${order.side} order at price ${order.price}...`);
            order.cancelButton.click();
            await this.delay(500);
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async waitForElement(selector, timeout = 5000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            const element = document.querySelector(selector);
            if (element) return element;
            await this.delay(100);
        }
        console.error(`Timeout: Element with selector "${selector}" not found after ${timeout}ms.`);
        return null;
    }

    async setInputValue(element, value) {
        function setNativeValue(element, value) {
            const valueSetter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set;
            valueSetter.call(element, value);
        }
        setNativeValue(element, value);
        element.dispatchEvent(new Event('keydown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('keypress', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('keyup', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await this.delay(100);
    }

    async getCurrentPrice() {
        const title = document.title;
        const match = title.match(/^[0-9,.]+/);
        if (!match) {
            console.error(`Could not find a price number in the document title: "${title}"`);
            return null;
        }
        const priceText = match[0].replace(/,/g, '');
        const price = parseFloat(priceText);
        if (isNaN(price)) {
            console.error(`Could not parse the price from the document title: "${title}"`);
            return null;
        }
        return price;
    }

    async execute(side, priceMultiplier) {
        try {
            console.log(`--- Executing ${side.toUpperCase()} Order with Multiplier: ${priceMultiplier} ---`);
            const currentPrice = await this.getCurrentPrice();
            if (currentPrice === null) {
                console.error("Halting script: could not get current price.");
                return;
            }
            console.log(`1. Current price retrieved: ${currentPrice}`);
            const targetPrice = parseFloat((currentPrice * priceMultiplier).toFixed(2));
            console.log(`2. Calculated target price: ${targetPrice}`);

            console.log("3. Clicking on the 'Limit Order' button...");
            let limitOrderButton = null;
            const buttons = document.querySelectorAll(StandxLimitOrder.SELECTORS.LIMIT_ORDER_BUTTON);
            for (const button of buttons) {
                if (button.textContent.trim().toUpperCase() === 'LIMIT') {
                    limitOrderButton = button;
                    break;
                }
            }
            if (!limitOrderButton) {
                console.error("Could not find the Limit Order button.");
                return;
            }
            limitOrderButton.click();

            console.log("4. Waiting for price and quantity inputs...");
            const priceInput = await this.waitForElement(StandxLimitOrder.SELECTORS.PRICE_INPUT);
            const quantityInput = await this.waitForElement(StandxLimitOrder.SELECTORS.QUANTITY_INPUT);

            if (!priceInput || !quantityInput) {
                console.error("Could not find the Price or Quantity input field after clicking Limit button.");
                return;
            }

            console.log(`5. Setting price to: ${targetPrice}`);
            await this.setInputValue(priceInput, targetPrice);
            console.log(`6. Setting quantity to: ${StandxLimitOrder.CONFIG.QUANTITY}`);
            await this.setInputValue(quantityInput, StandxLimitOrder.CONFIG.QUANTITY);
            console.log(`7. Submitting the '${side}' order...`);
            await this.delay(200);

            let submitButton = null;
            const allButtons = document.querySelectorAll('button');
            const sideText = side.toUpperCase();
            for (const button of allButtons) {
                if (button.textContent.trim().toUpperCase() === sideText && !button.closest('table')) {
                    submitButton = button;
                    break;
                }
            }
            if (!submitButton || submitButton.disabled) {
                console.error(`Could not find or click the ${sideText} button.`);
                return;
            }
            submitButton.click();
            console.log("--- Order Submitted Successfully! ---");
        } catch (error) {
            console.error("An error occurred during script execution:", error);
        }
    }

    async runTradingCycle() {
        this.loopCounter++;
        const maxLoops = StandxLimitOrder.CONFIG.MAX_LOOPS;
        const loop_msg = maxLoops > 0 ? `${this.loopCounter}/${maxLoops}` : `${this.loopCounter}`;
        console.log(`\n--- Running Trading Cycle [${loop_msg}] at ${new Date().toLocaleTimeString()} ---`);
        try {
            // 1. Indicators Check
            let skipPlacement = false;
            if (StandxLimitOrder.CONFIG.USE_INDICATORS) {
                const indicators = await this.getIndicatorsFromChart();
                if (indicators.atr !== null) {
                    console.log(`ATR: ${indicators.atr.toFixed(2)} (Prev: ${this.previousAtr !== null ? this.previousAtr.toFixed(2) : 'N/A'})`);
                    
                    if (indicators.atr > StandxLimitOrder.CONFIG.MAX_ATR) {
                        console.log(`ATR (${indicators.atr.toFixed(2)}) higher than MAX_ATR (${StandxLimitOrder.CONFIG.MAX_ATR}). Skipping placement.`);
                        skipPlacement = true;
                    } else if (this.previousAtr !== null) {
                        const atrChange = Math.abs(indicators.atr - this.previousAtr);
                        if (atrChange > StandxLimitOrder.CONFIG.ATR_CHANGE_THRESHOLD) {
                            console.log(`ATR change (${atrChange.toFixed(2)}) > threshold (${StandxLimitOrder.CONFIG.ATR_CHANGE_THRESHOLD}). Skipping placement.`);
                            skipPlacement = true;
                        }
                    }
                    this.previousAtr = indicators.atr;
                } else {
                    console.warn("Could not retrieve ATR from chart. Ensure indicator is enabled.");
                }
            }

        // 2. Handle Open Positions (Maker Exit Logic)
const openPositions = await this.getOpenPositions();
if (openPositions.length > 0) {
    console.log(`Managing ${openPositions.length} open position(s)...`);
    
    const currentPrice = await this.getCurrentPrice();
    const exitBps = 4; // or dynamic
    
    for (const position of openPositions) {
        if (position.side === 'long') {
            await this.execute('short', 1 + (exitBps / 10000));
        } else {
            await this.execute('long', 1 - (exitBps / 10000));
        }
        await this.delay(500);
    }
    
    return; // skip new placements this cycle
}

            // 3. Handle Open Orders & Distance Check (Always check)
            const openOrders = await this.getOpenOrders();
            const currentPrice = await this.getCurrentPrice();
            if (currentPrice === null) {
                console.error("Halting cycle: could not get current price.");
                return;
            }

            let ordersCancelled = false;
            if (openOrders.length > 0) {
                console.log(`Checking distances for ${openOrders.length} existing open order(s)...`);
                for (const order of openOrders) {
                    const bpsDistance = Math.abs(order.price - currentPrice) / currentPrice * 10000;
                    const tooFar = bpsDistance > StandxLimitOrder.CONFIG.MAX_DISTANCE_BPS;
                    const tooClose = bpsDistance < StandxLimitOrder.CONFIG.MIN_DISTANCE_BPS;

                    if (tooFar || tooClose) {
                        const reason = tooFar ? "too far" : "too close";
                        console.log(`Order at ${order.price} (${order.side}) is ${reason} (${bpsDistance.toFixed(2)} bps). Canceling.`);
                        await this.cancelOrder(order);
                        ordersCancelled = true;
                    }
                }

                if (ordersCancelled) {
                    console.log("Waiting for UI to update after cancellations...");
                    await this.delay(2000);
                }
            } else {
                console.log("No existing open orders to check.");
            }

            // 4. Placement Phase
            if (skipPlacement) {
                console.log("New order placement (initial or replacement) skipped due to volatility.");
            } else {
                // Refresh orders list if we cancelled any
                const finalOrders = ordersCancelled ? await this.getOpenOrders() : openOrders;

                if (finalOrders.length === 0) {
                    console.log("No open orders found. Performing initial placement...");
                    for (const bps of StandxLimitOrder.CONFIG.BPS_LADDER) {
                        await this.execute('long', 1 - (bps / 10000));
                        await this.delay(500);
                    }
                    for (const bps of StandxLimitOrder.CONFIG.BPS_LADDER) {
                        await this.execute('short', 1 + (bps / 10000));
                        await this.delay(500);
                    }
                    console.log("--- Initial Placement Complete ---");
                } else {
                    const currentLongOrders = finalOrders.filter(o => o.side === 'long');
                    const neededLongs = StandxLimitOrder.CONFIG.BPS_LADDER.length - currentLongOrders.length;
                    
                    if (neededLongs > 0) {
                        console.log(`Found ${currentLongOrders.length} long orders, need ${StandxLimitOrder.CONFIG.BPS_LADDER.length}. Placing ${neededLongs} new long order(s) at ${StandxLimitOrder.CONFIG.REPLACEMENT_BPS} bps.`);
                        const multiplier = 1 - (StandxLimitOrder.CONFIG.REPLACEMENT_BPS / 10000);
                        for (let i = 0; i < neededLongs; i++) {
                            await this.execute('long', multiplier);
                            await this.delay(500);
                        }
                    }

                    const currentShortOrders = finalOrders.filter(o => o.side === 'short');
                    const neededShorts = StandxLimitOrder.CONFIG.BPS_LADDER.length - currentShortOrders.length;
                    
                    if (neededShorts > 0) {
                        console.log(`Found ${currentShortOrders.length} short orders, need ${StandxLimitOrder.CONFIG.BPS_LADDER.length}. Placing ${neededShorts} new short order(s) at ${StandxLimitOrder.CONFIG.REPLACEMENT_BPS} bps.`);
                        const multiplier = 1 + (StandxLimitOrder.CONFIG.REPLACEMENT_BPS / 10000);
                        for (let i = 0; i < neededShorts; i++) {
                            await this.execute('short', multiplier);
                            await this.delay(500);
                        }
                    }

                    if (!ordersCancelled && neededLongs === 0 && neededShorts === 0) {
                        console.log("All open orders are correct and safe.");
                    }
                }
            }
        } catch (error) {
            console.error("A critical error occurred in the trading cycle:", error);
        }
        console.log("--- Trading Cycle Complete ---");

        if (maxLoops > 0 && this.loopCounter >= maxLoops) {
            console.log(`Max loops (${maxLoops}) reached. Stopping script.`);
            this.stop();
        }
    }

    start() {
        if (this.loopInterval) {
            console.log("Trading loop is already running.");
            return;
        }
        this.loopCounter = 0; // Reset counter on start
        console.log("Starting automated trading loop (runs every 30 seconds)...");
        console.log("To stop, run: orderPlacer.stop()");
        this.runTradingCycle();
        this.loopInterval = setInterval(() => this.runTradingCycle(), 4000);
    }

    stop() {
        if (this.loopInterval) {
            clearInterval(this.loopInterval);
            this.loopInterval = null;
            console.log("Automated trading loop stopped.");
        } else {
            console.log("Trading loop is not running.");
        }
    }
}

/*
// --- HOW TO RUN THE SCRIPT ---

1. Go to the `standx.com` page and open a fresh developer console (F12).
2. Copy the entire code block above this comment.
3. Paste it directly into the console and press Enter.
4. After the script is pasted, type the following line and press Enter:
   const orderPlacer = new StandxLimitOrder();
5. Finally, type this line and press Enter to begin:
   orderPlacer.start();
6. To stop the script, type:
   orderPlacer.stop();

*/
