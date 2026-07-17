import { Router, type IRouter } from 'express';
import { requireAuth } from '../middlewares/auth';
import { searchAirlines } from '../data/airlines';
import { searchAirports } from '../data/airports';
import { searchFlights } from '../lib/amadeus';

const router: IRouter = Router();

// GET /api/search/airlines?q=lufth
router.get('/search/airlines', requireAuth, (req, res): void => {
  const q = String(req.query.q ?? '');
  res.json(searchAirlines(q, 10));
});

// GET /api/search/airports?q=JFK  or  ?q=new york
router.get('/search/airports', requireAuth, (req, res): void => {
  const q = String(req.query.q ?? '');
  res.json(searchAirports(q, 10));
});

// GET /api/search/flights?origin=JFK&destination=LAX&date=2026-09-10
router.get('/search/flights', requireAuth, async (req, res): Promise<void> => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    res.status(400).json({ error: 'origin, destination, and date are required' });
    return;
  }

  if (
    !process.env.AMADEUS_CLIENT_ID ||
    !process.env.AMADEUS_CLIENT_SECRET
  ) {
    res.status(503).json({
      error: 'AMADEUS_CREDENTIALS_MISSING',
      message:
        'Flight search requires Amadeus API credentials. Get a free key at https://developers.amadeus.com and set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET.',
    });
    return;
  }

  try {
    const flights = await searchFlights(
      String(origin),
      String(destination),
      String(date)
    );
    res.json(flights);
  } catch (err: any) {
    if (err.message === 'AMADEUS_CREDENTIALS_MISSING') {
      res.status(503).json({ error: 'AMADEUS_CREDENTIALS_MISSING' });
      return;
    }
    console.error('Flight search error:', err.message);
    res.status(502).json({ error: 'Flight search failed', detail: err.message });
  }
});

export default router;
