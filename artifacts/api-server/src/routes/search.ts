import { Router, type IRouter } from 'express';
import { requireAuth } from '../middlewares/auth';
import { searchAirlines } from '../data/airlines';
import { searchAirports } from '../data/airports';
import { getScheduledFlights } from '../lib/aviationstack';
import { searchHotels } from '../lib/nominatim';

const router: IRouter = Router();

// GET /api/search/airlines?q=lufth  — public, static data
router.get('/search/airlines', (req, res): void => {
  const q = String(req.query.q ?? '');
  res.json(searchAirlines(q, 10));
});

// GET /api/search/airports?q=JFK  or  ?q=new york  — public, static data
router.get('/search/airports', (req, res): void => {
  const q = String(req.query.q ?? '');
  res.json(searchAirports(q, 10));
});

// GET /api/search/flights?origin=JFK&destination=NRT&date=2026-09-10
router.get('/search/flights', requireAuth, async (req, res): Promise<void> => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    res.status(400).json({ error: 'origin, destination, and date are required' });
    return;
  }

  if (!process.env.AVIATIONSTACK_API_KEY) {
    res.status(503).json({ error: 'AVIATIONSTACK_KEY_MISSING' });
    return;
  }

  try {
    const flights = await getScheduledFlights(
      String(origin),
      String(destination),
      String(date)
    );
    res.json(flights);
  } catch (err: any) {
    if (err.message === 'AVIATIONSTACK_KEY_MISSING') {
      res.status(503).json({ error: 'AVIATIONSTACK_KEY_MISSING' });
      return;
    }
    if (err.message === 'AVIATIONSTACK_PLAN_RESTRICTED') {
      res.status(402).json({ error: 'AVIATIONSTACK_PLAN_RESTRICTED' });
      return;
    }
    console.error('Flight search error:', err.message);
    res.status(502).json({ error: 'Flight search failed', detail: err.message });
  }
});

// GET /api/search/hotels?q=marriott+tokyo  — public
router.get('/search/hotels', async (req, res): Promise<void> => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) { res.json([]); return; }
  try {
    const results = await searchHotels(q);
    res.json(results);
  } catch (err: any) {
    console.error('Hotel search error:', err.message);
    res.status(502).json({ error: 'Hotel search failed' });
  }
});

export default router;
