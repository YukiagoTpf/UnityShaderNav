Shader "Integration/Consumer"
{
    Fallback "Integration/Library"
    SubShader
    {
        UsePass "Integration/Library/FORWARDLIT"
    }
}
