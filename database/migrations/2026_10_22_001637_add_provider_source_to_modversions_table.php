<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('modversions', function (Blueprint $table) {
            $table->string('provider', 32)->nullable();
            $table->string('provider_project_id')->nullable();
            $table->string('provider_version_id')->nullable();
            $table->index(['provider', 'provider_project_id']);
        });
    }

    public function down(): void
    {
        Schema::table('modversions', function (Blueprint $table) {
            $table->dropIndex(['provider', 'provider_project_id']);
            $table->dropColumn(['provider', 'provider_project_id', 'provider_version_id']);
        });
    }
};
