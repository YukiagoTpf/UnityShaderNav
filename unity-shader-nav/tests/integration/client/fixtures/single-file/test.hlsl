float4 helper(float4 v) { return v * 2.0; }
float4 main() {
    float4 x = float4(1,1,1,1);
    return helper(x);
}

struct Attributes {
    float3 positionOS;
};

cbuffer UnityPerMaterial {
    float4 _Color;
};

#pragma vertex main
