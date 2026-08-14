import { Trend, Counter, Rate } from 'k6/metrics';

// Jornada completa de um usuário novo: cadastro + ativação + login + cadastros
// padrões. É a métrica que responde "quanto custa um usuário entrando agora".
export const onboardingDuration = new Trend('onboarding_duration', true);
export const onboardingSuccess = new Rate('onboarding_success');

// As 6 chamadas que a home dispara de uma vez, medidas como um bloco só.
export const dashboardDuration = new Trend('dashboard_duration', true);

export const usersCreated = new Counter('users_created');
export const releasesCreated = new Counter('releases_created');
export const rateLimited = new Counter('rate_limited_429');
