const express = require('express');
const cors = require('cors');
const { mouse, Point, screen } = require('@nut-tree/nut-js');

const app = express();
const port = 4000;

app.use(cors());
app.use(express.json());

// Set mouse speed to be instantaneous for remote control
mouse.config.autoDelayMs = 0;

app.post('/click', async (req, res) => {
  const { x, y } = req.body;
  if (typeof x !== 'number' || typeof y !== 'number') {
    return res.status(400).send('Invalid coordinates');
  }

  try {
    const screenWidth = await screen.width();
    const screenHeight = await screen.height();

    const targetX = Math.round(x * screenWidth);
    const targetY = Math.round(y * screenHeight);

    console.log(`[Host] Moving mouse to (${targetX}, ${targetY}) and clicking.`);
    
    // Move and click
    await mouse.setPosition(new Point(targetX, targetY));
    await mouse.leftClick();

    res.sendStatus(200);
  } catch (err) {
    console.error('[Host] Error performing click:', err);
    res.status(500).send('Internal Error');
  }
});

app.listen(port, () => {
  console.log(`
=====================================================
  JumperCast Host Server Running
  Port: ${port}
  
  Keep this terminal open while sharing your screen.
  Your laptop will now execute clicks from your phone!
=====================================================
  `);
});
