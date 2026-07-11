#include "Shared.hlsl"

float4 Mixed(float value) { return value; }
float4 Mixed(float first, float second) { return first + second; }

float4 UseSuggestions(Surface surface) {
    float4 result = Mixed(1, 2);
    return float4(surface.po, 1);
}
