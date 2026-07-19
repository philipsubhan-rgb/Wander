import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import usersRouter from "./users";
import tripsRouter from "./trips";
import flightsRouter from "./flights";
import accommodationsRouter from "./accommodations";
import carRentalsRouter from "./carRentals";
import reservationsRouter from "./reservations";
import activitiesRouter from "./activities";
import itineraryRouter from "./itinerary";
import packingRouter from "./packing";
import notesRouter from "./notes";
import searchRouter from "./search";
import expensesRouter from "./expenses";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(tripsRouter);
router.use(flightsRouter);
router.use(accommodationsRouter);
router.use(carRentalsRouter);
router.use(reservationsRouter);
router.use(activitiesRouter);
router.use(itineraryRouter);
router.use(packingRouter);
router.use(notesRouter);
router.use(searchRouter);
router.use(expensesRouter);

export default router;
