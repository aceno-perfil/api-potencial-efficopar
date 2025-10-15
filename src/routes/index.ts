import { Router } from "express";
import rangesAndWeightsRoute from "./ranges-and-weights.route";
import gruposRoute from "./grupos.route";
import { catalogRouter } from './catalog.route';
import { paramsRouter } from './params.route';
import { paramsListRouter } from "./params-list.route";
import paramsSaveRouter from "./params-save.route";

const router = Router();

// Registra todas as rotas
router.use(rangesAndWeightsRoute);
router.use(gruposRoute);
router.use(catalogRouter);
router.use(paramsListRouter);
router.use(paramsRouter);
router.use(paramsSaveRouter);

export default router;

