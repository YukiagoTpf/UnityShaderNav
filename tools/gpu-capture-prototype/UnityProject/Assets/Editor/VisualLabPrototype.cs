using System;
using UnityEditor;
using UnityEngine;

namespace UnityShaderNav.VisualLabPrototype
{
    public static class VisualLabPrototype
    {
        public const string MaterialAsset =
            "Assets/Materials/VisualLabProbe.mat";
        private const string ShaderName =
            "UnityShaderNav/VisualLabProbe";

        public static void SetupProbeMaterial()
        {
            var shader = Shader.Find(ShaderName);
            if (shader == null)
            {
                throw new InvalidOperationException(
                    "VisualLabProbe Shader did not import.");
            }

            var material = AssetDatabase.LoadAssetAtPath<Material>(
                MaterialAsset);
            if (material == null)
            {
                const string directory = "Assets/Materials";
                if (!AssetDatabase.IsValidFolder(directory))
                {
                    AssetDatabase.CreateFolder("Assets", "Materials");
                }
                material = new Material(shader)
                {
                    name = "VisualLabProbe"
                };
                material.SetColor(
                    "_PreviewTint",
                    new Color(0.08f, 0.42f, 0.85f, 1.0f));
                AssetDatabase.CreateAsset(material, MaterialAsset);
            }
            else if (material.shader != shader)
            {
                material.shader = shader;
                EditorUtility.SetDirty(material);
            }

            AssetDatabase.SaveAssets();
            AssetDatabase.ImportAsset(
                MaterialAsset,
                ImportAssetOptions.ForceSynchronousImport
                | ImportAssetOptions.ForceUpdate);
            Debug.Log(
                "[UnityShaderNav Visual Lab] prepared "
                + MaterialAsset
                + ".");
        }

        public static void SelectProbeMaterial()
        {
            SetupProbeMaterial();
            var material = AssetDatabase.LoadAssetAtPath<Material>(
                MaterialAsset);
            if (material == null)
            {
                throw new InvalidOperationException(
                    "VisualLabProbe Material was not created.");
            }
            Selection.activeObject = material;
            EditorGUIUtility.PingObject(material);
            Debug.Log(
                "[UnityShaderNav Visual Lab] selected "
                + AssetDatabase.AssetPathToGUID(MaterialAsset)
                + ".");
        }
    }
}
