window.requestAnimationFrame = (function(){
    return  window.requestAnimationFrame       ||
        window.webkitRequestAnimationFrame ||
        window.mozRequestAnimationFrame    ||
        window.oRequestAnimationFrame      ||
        window.msRequestAnimationFrame     ||
        function (callback) {
            window.setTimeout(callback, 1000 / 60);
        };
})();

var Configs = {
    backgroundColor: '#1a1a1a',
    particleNum: 1000,
    step: 4,
    base: 750,
    zInc: 0.00001,
    larguraSVG: 1200,
    sensibilidade: 0.2
};

var canvas, context, screenWidth, screenHeight, centerX, centerY, trackerEl, simplexNoise;
var barraSVG, barraTopo, svgContainer;
var particles = [], zoff = 0;
var progressoTotal = 0, ultimoX = null, ultimoY = null;
var targetZInc = 0.00001, targetStep = 4, targetBase = 750, mouseTimeout;

// NOVA VARIÁVEL: Controla quando o texto deve tremer
var isShaking = false;

function init() {
    canvas = document.getElementById('c');
    trackerEl = document.getElementById('tracker');
    barraSVG = document.getElementById('barra-mouse');
    barraTopo = document.getElementById('barra-topo-preenchimento');
    svgContainer = document.getElementById('svg-container');

    window.addEventListener('resize', onWindowResize, false);
    onWindowResize(null);

    simplexNoise = new SimplexNoise();

    for (var i = 0, len = Configs.particleNum; i < len; i++) {
        initParticle((particles[i] = new Particle()));
    }

    canvas.addEventListener('click', onCanvasClick, false);
    document.addEventListener('mousemove', onMouseMove, false);
    document.addEventListener('touchmove', onMouseMove, {passive: false});

    update();
}

function onWindowResize(e) {
    screenWidth  = canvas.width  = window.innerWidth;
    screenHeight = canvas.height = window.innerHeight;
    centerX = screenWidth / 2;
    centerY = screenHeight / 2;
    context = canvas.getContext('2d');
    context.lineCap = context.lineJoin = 'round';
}

function onCanvasClick(e) {
    context.save();
    context.globalAlpha = 0.8;
    context.fillStyle = Configs.backgroundColor;
    context.fillRect(0, 0, screenWidth, screenHeight);
    context.restore();
    simplexNoise = new SimplexNoise();
}

function onMouseMove(e) {
    var x = e.clientX || (e.touches && e.touches[0].clientX);
    var y = e.clientY || (e.touches && e.touches[0].clientY);

    if (ultimoX !== null && ultimoY !== null) {
        var deltaX = x - ultimoX;
        var deltaY = y - ultimoY;
        var dist = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));

        progressoTotal += (dist * Configs.sensibilidade);
        if (progressoTotal > Configs.larguraSVG) {
            progressoTotal = Configs.larguraSVG;
        }
    }
    ultimoX = x;
    ultimoY = y;

    // Enquanto mexe o mouse, acelera e treme
    targetZInc = 0.01;
    targetStep = 8;
    targetBase = 2500;
    isShaking = true; // LIGA A TREMEDEIRA

    clearTimeout(mouseTimeout);
    mouseTimeout = setTimeout(function() {
        // Quando o mouse para, acalma tudo
        targetZInc = 0.00005;
        targetStep = 4;
        targetBase = 750;
        isShaking = false; // DESLIGA A TREMEDEIRA
    }, 150);
}

function getNoise(x, y, z) {
    var octaves = 4, fallout = 0.5, amp = 1, f = 1, sum = 0, i;
    for (i = 0; i < octaves; ++i) {
        amp *= fallout;
        sum += amp * (simplexNoise.noise3D(x * f, y * f, z * f) + 1) * 0.5;
        f *= 2;
    }
    return sum;
}

function initParticle(p) {
    p.x = p.pastX = screenWidth * Math.random();
    p.y = p.pastY = screenHeight * Math.random();

    if (Math.random() < 0.0) {
        p.isEraser = true;
    } else {
        p.isEraser = false;
        // Voltei a cor exata do seu código original
        if (Math.random() < 0.5) {
            p.color.h = (345 + Math.random() * 30) % 300;
        } else {
            p.color.h = 185 + Math.random() * 30;
        }
        p.color.s = 1;
        p.color.l = 0.5;
        p.color.a = 0;
    }
}

function update() {
    var step = Configs.step, base = Configs.base, i, p, angle;

    Configs.zInc += (targetZInc - Configs.zInc) * 0.05;
    Configs.step += (targetStep - Configs.step) * 0.05;
    Configs.base += (targetBase - Configs.base) * 0.05;

    if (barraSVG && barraTopo) {
        barraSVG.setAttribute('width', progressoTotal);
        barraTopo.style.width = (progressoTotal / Configs.larguraSVG * 100) + "%";
    }

    // ==========================================
    // LÓGICA DE TREMEDEIRA CORRIGIDA
    // ==========================================
    if (isShaking && progressoTotal > 0 && progressoTotal < Configs.larguraSVG) {
        var intensidade = 6; // Intensidade (se quiser mais louco, aumente esse número)
        var shakeX = (Math.random() - 0.5) * intensidade;
        var shakeY = (Math.random() - 0.5) * intensidade;

        // Forma à prova de bugs de navegador (usa dois translates em vez de calc)
        svgContainer.style.transform = `translate(-50%, -50%) translate(${shakeX}px, ${shakeY}px)`;
    } else {
        // Trava cravado no meio quando para de mexer ou chega no 100%
        svgContainer.style.transform = 'translate(-50%, -50%)';
    }
    // ==========================================

    trackerEl.innerHTML =
        '<strong>DEBUG TRACKER</strong><br><br>' +
        'Step : ' + Configs.step.toFixed(1) + '<br>' +
        'Base : ' + Configs.base.toFixed(1) + '<br>' +
        'zInc : ' + Configs.zInc.toFixed(6);

    for (i = 0, len = particles.length; i < len; i++) {
        p = particles[i];
        p.pastX = p.x;
        p.pastY = p.y;

        angle = Math.PI * 6 * getNoise(p.x / base * 1.75, p.y / base * 1.75, zoff);
        p.x += Math.cos(angle) * step;
        p.y += Math.sin(angle) * step;

        if (!p.isEraser && p.color.a < 1) p.color.a += 0.003;

        context.beginPath();

        if (p.isEraser) {
            context.strokeStyle = Configs.backgroundColor;
            context.lineWidth = 2.0;
        } else {
            context.strokeStyle = p.color.toString();
            context.lineWidth = 0.5;
        }

        context.moveTo(p.pastX, p.pastY);
        context.lineTo(p.x, p.y);
        context.stroke();

        if (p.x < 0 || p.x > screenWidth || p.y < 0 || p.y > screenHeight) {
            initParticle(p);
        }
    }
    zoff += Configs.zInc;
    requestAnimationFrame(update);
}

function HSLA(h, s, l, a) {
    this.h = h || 0; this.s = s || 0; this.l = l || 0; this.a = a || 0;
}

HSLA.prototype.toString = function() {
    return 'hsla(' + this.h + ',' + (this.s * 100) + '%,' + (this.l * 100) + '%,' + this.a + ')';
}

function Particle(x, y, color) {
    this.x = x || 0; this.y = y || 0; this.color = color || new HSLA();
    this.pastX = this.x; this.pastY = this.y;
    this.isEraser = false;
}

init();