package com.sentrifugo.pms.service;

import com.sentrifugo.common.exception.DomainException;
import com.sentrifugo.db.dto.PmsCycleApplicabilityDTO;
import com.sentrifugo.db.dto.PmsCycleDTO;
import com.sentrifugo.db.dto.PmsCycleStageDTO;
import com.sentrifugo.db.entity.PmsCycleApplicabilityEntity;
import com.sentrifugo.db.entity.PmsCycleDepartmentEntity;
import com.sentrifugo.db.entity.PmsCycleEmploymentTypeEntity;
import com.sentrifugo.db.entity.PmsCycleEntity;
import com.sentrifugo.db.entity.PmsCyclePlantEntity;
import com.sentrifugo.db.entity.PmsCycleStageEntity;
import com.sentrifugo.db.enums.PmsCycleStageType;
import com.sentrifugo.db.enums.PmsCycleStatus;
import com.sentrifugo.db.enums.PmsCycleType;
import com.sentrifugo.db.enums.PmsEmploymentType;
import com.sentrifugo.db.enums.PmsMasterStatus;
import com.sentrifugo.db.mapper.PmsCycleApplicabilityMapper;
import com.sentrifugo.db.mapper.PmsCycleMapper;
import com.sentrifugo.db.mapper.PmsCycleStageMapper;
import com.sentrifugo.db.repository.PmsCycleApplicabilityRepository;
import com.sentrifugo.db.repository.PmsCycleDepartmentRepository;
import com.sentrifugo.db.repository.PmsCycleEligibilityRunRepository;
import com.sentrifugo.db.repository.PmsCycleEmploymentTypeRepository;
import com.sentrifugo.db.repository.PmsCycleNotificationRepository;
import com.sentrifugo.db.repository.PmsCyclePlantRepository;
import com.sentrifugo.db.repository.PmsCycleRepository;
import com.sentrifugo.db.repository.PmsCycleStageRepository;
import com.sentrifugo.db.repository.PmsRatingScaleRepository;
import com.sentrifugo.db.util.PmsCycleSpecifications;
import com.sentrifugo.pms.model.PmsCycleActivationResponse;
import com.sentrifugo.pms.model.PmsCycleListResponse;
import com.sentrifugo.pms.model.PmsCycleRequest;
import com.sentrifugo.pms.model.PmsCycleResponse;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.Month;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Business logic for PMS cycles (screens 1.1-1.6). Every operation is scoped to the caller's organisation, which
 * always comes from the authenticated session and never from a request.
 *
 * <p>Not implemented because the supporting integration does not exist yet: the eligible-employee preview, the
 * eligibility run and the publish notifications (both need the Sentrifugo / messaging integration), and name
 * resolution for plants and departments.
 */
@Service
@RequiredArgsConstructor
public class PmsCycleService {

    private static final Logger log = LoggerFactory.getLogger(PmsCycleService.class);

    private static final int DEFAULT_PAGE_SIZE = 20;
    private static final int MAX_PAGE_SIZE = 100;

    private final PmsCycleRepository cycleRepository;
    private final PmsCycleStageRepository stageRepository;
    private final PmsCycleApplicabilityRepository applicabilityRepository;
    private final PmsCyclePlantRepository plantRepository;
    private final PmsCycleDepartmentRepository departmentRepository;
    private final PmsCycleEmploymentTypeRepository employmentTypeRepository;
    private final PmsCycleNotificationRepository notificationRepository;
    private final PmsCycleEligibilityRunRepository eligibilityRunRepository;
    private final PmsRatingScaleRepository ratingScaleRepository;
    private final PmsCycleMapper cycleMapper;
    private final PmsCycleStageMapper stageMapper;
    private final PmsCycleApplicabilityMapper applicabilityMapper;

    // ── Reads ────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public PmsCycleListResponse getCycles(UUID organisationId, String search, Integer year, String type,
                                          UUID plantId, String status, int skip, int limit) {
        PmsCycleType typeFilter = isBlank(type) ? null : parseType(type);
        PmsCycleStatus statusFilter = isBlank(status) ? null : parseStatus(status);
        int pageSize = limit <= 0 ? DEFAULT_PAGE_SIZE : Math.min(limit, MAX_PAGE_SIZE);
        if (skip < 0 || skip % pageSize != 0) {
            throw DomainException.unprocessable("skip must be a non-negative multiple of limit", "VALIDATION_ERROR");
        }

        // The summary honours every filter except status, so the stat cards stay stable while a status tab is
        // selected; total and items honour status as well.
        var shared = PmsCycleSpecifications.matching(organisationId, search, year, typeFilter, plantId);
        PmsCycleListResponse.Summary summary = new PmsCycleListResponse.Summary(
                cycleRepository.count(shared),
                cycleRepository.count(shared.and(PmsCycleSpecifications.statusIs(PmsCycleStatus.DRAFT))),
                cycleRepository.count(shared.and(PmsCycleSpecifications.statusIs(PmsCycleStatus.ACTIVE))),
                cycleRepository.count(shared.and(PmsCycleSpecifications.statusIs(PmsCycleStatus.CLOSED))),
                cycleRepository.count(shared.and(PmsCycleSpecifications.statusIs(PmsCycleStatus.CANCELLED))));

        var page = cycleRepository.findAll(shared.and(PmsCycleSpecifications.statusIs(statusFilter)),
                PageRequest.of(skip / pageSize, pageSize, Sort.by(Sort.Direction.DESC, "createdDate")));
        List<PmsCycleListResponse.Item> items = page.getContent().stream().map(this::toListItem).toList();
        return new PmsCycleListResponse(items, page.getTotalElements(), summary);
    }

    @Transactional(readOnly = true)
    public List<PmsCycleListResponse.Item> getCyclesForExport(UUID organisationId, String search, Integer year,
                                                              String type, UUID plantId, String status) {
        PmsCycleType typeFilter = isBlank(type) ? null : parseType(type);
        PmsCycleStatus statusFilter = isBlank(status) ? null : parseStatus(status);
        var spec = PmsCycleSpecifications.matching(organisationId, search, year, typeFilter, plantId)
                .and(PmsCycleSpecifications.statusIs(statusFilter));
        return cycleRepository.findAll(spec, Sort.by(Sort.Direction.DESC, "createdDate")).stream()
                .map(this::toListItem).toList();
    }

    @Transactional(readOnly = true)
    public PmsCycleResponse getCycle(UUID organisationId, UUID cycleId) {
        return toResponse(findCycle(organisationId, cycleId));
    }

    @Transactional(readOnly = true)
    public PmsCycleActivationResponse getActivation(UUID organisationId, UUID cycleId) {
        PmsCycleEntity cycle = findCycle(organisationId, cycleId);
        if (cycle.getStatus() == PmsCycleStatus.DRAFT) {
            throw DomainException.conflict("This cycle has not been published yet.", "PMS_CYCLE_NOT_PUBLISHED");
        }
        return toActivation(cycle);
    }

    // ── Writes ───────────────────────────────────────────────────────────────

    /** Wizard step 1 "Next" / later steps' "Next": saves whatever sections the payload carries as a DRAFT. */
    @Transactional
    public PmsCycleResponse createCycle(UUID organisationId, PmsCycleRequest request) {
        log.info("Creating PMS cycle for organisation {}", organisationId);
        PmsCycleType type = validateBasic(request.basic());
        validateStages(request.stages());
        PmsCycleRequest.Finalize settings = request.finalizeSettings();
        assertRatingScaleUsable(organisationId, settings == null ? null : settings.ratingScaleId());

        // Defaults are filled in here because the entity columns are NOT NULL and a null in the DTO would be
        // copied straight onto the entity.
        PmsCycleDTO dto = PmsCycleDTO.builder()
                .name(request.basic().name().trim())
                .description(request.basic().description())
                .type(type)
                .periodStart(request.basic().periodStart())
                .periodEnd(request.basic().periodEnd())
                .ratingScaleId(settings == null ? null : settings.ratingScaleId())
                .notifyManagers(flag(settings == null ? null : settings.notifyManagers()))
                .notifyEmployees(flag(settings == null ? null : settings.notifyEmployees()))
                .notifyHod(flag(settings == null ? null : settings.notifyHod()))
                .notifyHr(flag(settings == null ? null : settings.notifyHr()))
                .currentStep(request.currentStep() == null ? 1 : request.currentStep())
                .completedStep(request.completedStep() == null ? 0 : request.completedStep())
                .build();

        PmsCycleEntity cycle = cycleMapper.toEntity(dto);
        cycle.setOrganisationId(organisationId);
        cycle.setCycleCode(generateCycleCode(type, request.basic().periodStart()));
        cycle.setStatus(PmsCycleStatus.DRAFT);
        cycle = cycleRepository.save(cycle);

        saveChildren(cycle, request);
        return toResponse(cycle);
    }

    @Transactional
    public PmsCycleResponse updateCycle(UUID organisationId, UUID cycleId, PmsCycleRequest request) {
        log.info("Updating PMS cycle {}", cycleId);
        PmsCycleEntity cycle = findCycle(organisationId, cycleId);
        if (cycle.getStatus() != PmsCycleStatus.DRAFT && cycle.getStatus() != PmsCycleStatus.ACTIVE) {
            log.warn("PMS cycle {} cannot be edited in status {}", cycleId, cycle.getStatus());
            throw DomainException.conflict("Only a draft or active cycle can be edited.",
                    "PMS_CYCLE_NOT_EDITABLE");
        }
        PmsCycleType type = validateBasic(request.basic());
        validateStages(request.stages());
        PmsCycleRequest.Finalize settings = request.finalizeSettings();
        assertRatingScaleUsable(organisationId, settings == null ? null : settings.ratingScaleId());

        // Only the editable fields are set; the mapper ignores nulls, so id, organisation, cycle code, status and
        // audit columns can never be touched through this path.
        PmsCycleDTO dto = PmsCycleDTO.builder()
                .name(request.basic().name().trim())
                .description(request.basic().description())
                .type(type)
                .periodStart(request.basic().periodStart())
                .periodEnd(request.basic().periodEnd())
                .ratingScaleId(settings == null ? null : settings.ratingScaleId())
                .notifyManagers(settings == null ? null : settings.notifyManagers())
                .notifyEmployees(settings == null ? null : settings.notifyEmployees())
                .notifyHod(settings == null ? null : settings.notifyHod())
                .notifyHr(settings == null ? null : settings.notifyHr())
                .currentStep(request.currentStep())
                .completedStep(request.completedStep())
                .build();
        cycleMapper.updateEntityFromDto(dto, cycle);
        cycle = cycleRepository.save(cycle);

        saveChildren(cycle, request);
        return toResponse(cycle);
    }

    /** Screen 1.5 "Publish Cycle": DRAFT to ACTIVE once the whole configuration is present. */
    @Transactional
    public PmsCycleActivationResponse publishCycle(UUID organisationId, UUID cycleId) {
        log.info("Publishing PMS cycle {}", cycleId);
        PmsCycleEntity cycle = findCycle(organisationId, cycleId);
        if (cycle.getStatus() != PmsCycleStatus.DRAFT) {
            log.warn("PMS cycle {} cannot be published because it is in status {}", cycleId, cycle.getStatus());
            throw DomainException.conflict("Only a draft cycle can be published.", "PMS_CYCLE_NOT_PUBLISHABLE");
        }
        assertPublishable(organisationId, cycle);

        cycle.setStatus(PmsCycleStatus.ACTIVE);
        cycle.setPublishedOn(LocalDateTime.now());
        cycle.setCurrentStep(4);
        cycle.setCompletedStep(4);
        PmsCycleEntity saved = cycleRepository.save(cycle);
        log.warn("PMS cycle {} published; the eligibility run and notifications are not implemented yet", cycleId);
        return toActivation(saved);
    }

    @Transactional
    public PmsCycleResponse cancelCycle(UUID organisationId, UUID cycleId) {
        log.info("Cancelling PMS cycle {}", cycleId);
        PmsCycleEntity cycle = findCycle(organisationId, cycleId);
        if (cycle.getStatus() != PmsCycleStatus.DRAFT && cycle.getStatus() != PmsCycleStatus.ACTIVE) {
            log.warn("PMS cycle {} cannot be cancelled in status {}", cycleId, cycle.getStatus());
            throw DomainException.conflict("Only a draft or active cycle can be cancelled.",
                    "PMS_CYCLE_NOT_CANCELLABLE");
        }
        cycle.setStatus(PmsCycleStatus.CANCELLED);
        return toResponse(cycleRepository.save(cycle));
    }

    // ── Children: stages (1.3), applicability (1.4) ──────────────────────────

    /** A supplied section replaces what is stored; an omitted one is left unchanged. */
    private void saveChildren(PmsCycleEntity cycle, PmsCycleRequest request) {
        if (request.stages() != null) {
            stageRepository.deleteByCycleId(cycle.getId());
            stageRepository.flush(); // the (cycle, stage) unique key would otherwise clash with the inserts below
            for (PmsCycleRequest.Stage stage : request.stages()) {
                PmsCycleStageEntity row = stageMapper.toEntity(PmsCycleStageDTO.builder()
                        .stage(parseStage(stage.stage()))
                        .startDate(stage.startDate())
                        .endDate(stage.endDate())
                        .notificationEnabled(flag(stage.notifyEnabled()))
                        .build());
                row.setCycle(cycle);
                stageRepository.save(row);
            }
        }
        if (request.applicability() != null) {
            saveApplicability(cycle, request.applicability());
        }
    }

    private void saveApplicability(PmsCycleEntity cycle, PmsCycleRequest.Applicability a) {
        boolean allPlants = flag(a.allPlants());
        boolean allDepartments = a.allDepartments() == null || a.allDepartments();
        Set<UUID> plantIds = allPlants ? Set.of() : distinct(a.plantIds());
        Set<UUID> departmentIds = allDepartments ? Set.of() : distinct(a.departmentIds());
        Set<PmsEmploymentType> employmentTypes = new java.util.LinkedHashSet<>();
        if (a.employmentTypes() != null) {
            a.employmentTypes().forEach(t -> employmentTypes.add(parseEmploymentType(t)));
        }

        PmsCycleApplicabilityDTO dto = PmsCycleApplicabilityDTO.builder()
                .allPlants(allPlants)
                .allDepartments(allDepartments)
                .minimumServiceMonths(a.minServiceMonths())
                .serviceCalculatedAsOn(a.serviceAsOn())
                .excludeProbation(flag(a.excludeProbation()))
                .excludeNoticePeriod(flag(a.excludeNoticePeriod()))
                .build();
        PmsCycleApplicabilityEntity row = applicabilityRepository.findByCycleId(cycle.getId()).orElse(null);
        if (row == null) {
            row = applicabilityMapper.toEntity(dto);
            row.setCycle(cycle);
        } else {
            // A full replace: minimum service / as-on date may be cleared, so null is written, not ignored.
            row.setAllPlants(dto.getAllPlants());
            row.setAllDepartments(dto.getAllDepartments());
            row.setMinimumServiceMonths(dto.getMinimumServiceMonths());
            row.setServiceCalculatedAsOn(dto.getServiceCalculatedAsOn());
            row.setExcludeProbation(dto.getExcludeProbation());
            row.setExcludeNoticePeriod(dto.getExcludeNoticePeriod());
        }
        applicabilityRepository.save(row);

        plantRepository.deleteByCycleId(cycle.getId());
        departmentRepository.deleteByCycleId(cycle.getId());
        employmentTypeRepository.deleteByCycleId(cycle.getId());
        plantRepository.flush();
        plantIds.forEach(id -> plantRepository.save(
                PmsCyclePlantEntity.builder().cycle(cycle).plantId(id).build()));
        departmentIds.forEach(id -> departmentRepository.save(
                PmsCycleDepartmentEntity.builder().cycle(cycle).departmentId(id).build()));
        employmentTypes.forEach(t -> employmentTypeRepository.save(
                PmsCycleEmploymentTypeEntity.builder().cycle(cycle).employmentType(t).build()));
    }

    // ── Validation ───────────────────────────────────────────────────────────

    private PmsCycleType validateBasic(PmsCycleRequest.Basic basic) {
        if (!basic.periodEnd().isAfter(basic.periodStart())) {
            throw DomainException.unprocessable("period_end must be after period_start", "VALIDATION_ERROR");
        }
        return parseType(basic.type());
    }

    private void validateStages(List<PmsCycleRequest.Stage> stages) {
        if (stages == null) {
            return;
        }
        Set<PmsCycleStageType> seen = EnumSet.noneOf(PmsCycleStageType.class);
        for (PmsCycleRequest.Stage stage : stages) {
            PmsCycleStageType type = parseStage(stage.stage());
            if (!seen.add(type)) {
                throw DomainException.unprocessable(
                        "Stage '" + stage.stage() + "' is listed more than once.", "VALIDATION_ERROR");
            }
            if (stage.startDate() != null && stage.endDate() != null && stage.endDate().isBefore(stage.startDate())) {
                throw DomainException.unprocessable(
                        "Stage '" + stage.stage() + "': end_date must not be before start_date", "VALIDATION_ERROR");
            }
        }
    }

    /** A rating scale, when named, must be an active one of the caller's organisation. */
    private void assertRatingScaleUsable(UUID organisationId, UUID ratingScaleId) {
        if (ratingScaleId == null) {
            return;
        }
        boolean usable = ratingScaleRepository.findByIdAndOrganisationId(ratingScaleId, organisationId)
                .filter(s -> Boolean.TRUE.equals(s.getIsActive()) && s.getStatus() == PmsMasterStatus.ACTIVE)
                .isPresent();
        if (!usable) {
            throw DomainException.unprocessable("rating_scale_id does not refer to an active rating scale",
                    "PMS_RATING_SCALE_NOT_FOUND");
        }
    }

    /** Everything a draft may omit but an active cycle needs; all gaps are reported together. */
    private void assertPublishable(UUID organisationId, PmsCycleEntity cycle) {
        List<String> problems = new ArrayList<>();
        UUID id = cycle.getId();

        if (cycle.getRatingScaleId() == null) {
            problems.add("a rating scale must be selected");
        } else {
            try {
                assertRatingScaleUsable(organisationId, cycle.getRatingScaleId());
            } catch (DomainException e) {
                problems.add("the selected rating scale is not available");
            }
        }

        PmsCycleApplicabilityEntity applicability = applicabilityRepository.findByCycleId(id).orElse(null);
        if (applicability == null) {
            problems.add("applicability has not been configured");
        } else {
            if (!Boolean.TRUE.equals(applicability.getAllPlants()) && plantRepository.findByCycleId(id).isEmpty()) {
                problems.add("at least one plant must be selected");
            }
            if (!Boolean.TRUE.equals(applicability.getAllDepartments())
                    && departmentRepository.findByCycleId(id).isEmpty()) {
                problems.add("at least one department must be selected when not applying to all departments");
            }
            if (applicability.getMinimumServiceMonths() == null) {
                problems.add("minimum service (months) is required");
            }
            if (applicability.getServiceCalculatedAsOn() == null) {
                problems.add("the service-calculated-as-on date is required");
            }
        }
        if (employmentTypeRepository.findByCycleId(id).isEmpty()) {
            problems.add("at least one employment type must be selected");
        }

        Set<PmsCycleStageType> complete = EnumSet.noneOf(PmsCycleStageType.class);
        stageRepository.findByCycleId(id).stream()
                .filter(s -> s.getStartDate() != null && s.getEndDate() != null)
                .forEach(s -> complete.add(s.getStage()));
        for (PmsCycleStageType stage : PmsCycleStageType.values()) {
            if (!complete.contains(stage)) {
                problems.add("stage " + wire(stage) + " needs both a start and end date");
            }
        }

        if (!problems.isEmpty()) {
            log.warn("PMS cycle {} cannot be published: {}", id, problems);
            throw DomainException.unprocessable("Cycle cannot be published: " + String.join("; ", problems) + ".",
                    "PMS_CYCLE_PUBLISH_VALIDATION_FAILED");
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** Organisation-scoped lookup: a cycle of another organisation is indistinguishable from a missing one. */
    private PmsCycleEntity findCycle(UUID organisationId, UUID cycleId) {
        return cycleRepository.findByIdAndOrganisationId(cycleId, organisationId)
                .orElseThrow(() -> DomainException.notFound("Cycle not found", "PMS_CYCLE_NOT_FOUND"));
    }

    /** {@code PMS-{FYstart yy}{FYend yy}-{A|M|C}}, with a numeric suffix ({@code PMS-2627-A2}) when taken. */
    private String generateCycleCode(PmsCycleType type, LocalDate periodStart) {
        int fyStart = periodStart.getMonthValue() >= Month.APRIL.getValue()
                ? periodStart.getYear() : periodStart.getYear() - 1;
        String letter = switch (type) {
            case ANNUAL -> "A";
            case MID_YEAR -> "M";
            case CUSTOM -> "C";
        };
        String base = "PMS-" + twoDigits(fyStart) + twoDigits(fyStart + 1) + "-" + letter;
        if (!cycleRepository.existsByCycleCode(base)) {
            return base;
        }
        for (int suffix = 2; suffix < 100; suffix++) {
            String candidate = base + suffix;
            if (!cycleRepository.existsByCycleCode(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("Exhausted cycle_code suffixes for " + base);
    }

    private static PmsCycleType parseType(String value) {
        try {
            return PmsCycleType.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("type must be one of: annual, mid_year, custom", "VALIDATION_ERROR");
        }
    }

    private static PmsCycleStatus parseStatus(String value) {
        try {
            return PmsCycleStatus.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("status must be one of: draft, active, closed, cancelled",
                    "VALIDATION_ERROR");
        }
    }

    private static PmsCycleStageType parseStage(String value) {
        try {
            return PmsCycleStageType.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("Unknown stage '" + value + "'", "VALIDATION_ERROR");
        }
    }

    private static PmsEmploymentType parseEmploymentType(String value) {
        try {
            return PmsEmploymentType.valueOf(value.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw DomainException.unprocessable("employment type must be one of: permanent, contract, trainee",
                    "VALIDATION_ERROR");
        }
    }

    private PmsCycleListResponse.Item toListItem(PmsCycleEntity cycle) {
        boolean allPlants = applicabilityRepository.findByCycleId(cycle.getId())
                .map(a -> Boolean.TRUE.equals(a.getAllPlants())).orElse(false);
        return new PmsCycleListResponse.Item(cycle.getId(), cycle.getCycleCode(), cycle.getName(),
                wire(cycle.getType()), cycle.getPeriodStart(), cycle.getPeriodEnd(), allPlants ? "All Plants" : null,
                wire(cycle.getStatus()), toDate(cycle.getCreatedDate()));
    }

    private PmsCycleResponse toResponse(PmsCycleEntity cycle) {
        PmsCycleDTO dto = cycleMapper.toDTO(cycle);
        UUID id = cycle.getId();

        List<PmsCycleResponse.Stage> stages = stageRepository.findByCycleId(id).stream()
                .sorted(Comparator.comparing(PmsCycleStageEntity::getStage))
                .map(s -> new PmsCycleResponse.Stage(wire(s.getStage()), s.getStartDate(), s.getEndDate(),
                        Boolean.TRUE.equals(s.getNotificationEnabled())))
                .toList();

        PmsCycleResponse.Applicability applicability = applicabilityRepository.findByCycleId(id)
                .map(a -> new PmsCycleResponse.Applicability(
                        Boolean.TRUE.equals(a.getAllPlants()),
                        plantRepository.findByCycleId(id).stream().map(PmsCyclePlantEntity::getPlantId).toList(),
                        Boolean.TRUE.equals(a.getAllDepartments()),
                        departmentRepository.findByCycleId(id).stream()
                                .map(PmsCycleDepartmentEntity::getDepartmentId).toList(),
                        employmentTypeRepository.findByCycleId(id).stream()
                                .map(e -> wire(e.getEmploymentType())).sorted().toList(),
                        a.getMinimumServiceMonths(), a.getServiceCalculatedAsOn(),
                        Boolean.TRUE.equals(a.getExcludeProbation()),
                        Boolean.TRUE.equals(a.getExcludeNoticePeriod())))
                .orElse(null);

        return new PmsCycleResponse(dto.getId(), dto.getCycleCode(), wire(dto.getStatus()),
                toDate(dto.getCreatedDate()), toDate(dto.getPublishedOn()),
                applicability != null && applicability.allPlants() ? "All Plants" : null,
                new PmsCycleResponse.Basic(dto.getName(), dto.getDescription(), wire(dto.getType()),
                        dto.getPeriodStart(), dto.getPeriodEnd()),
                stages, applicability,
                new PmsCycleResponse.Finalize(dto.getRatingScaleId(), dto.getNotifyManagers(),
                        dto.getNotifyEmployees(), dto.getNotifyHod(), dto.getNotifyHr()),
                dto.getCurrentStep(), dto.getCompletedStep());
    }

    private PmsCycleActivationResponse toActivation(PmsCycleEntity cycle) {
        List<PmsCycleActivationResponse.Notification> notifications =
                notificationRepository.findByCycleIdOrderByCreatedDateAsc(cycle.getId()).stream()
                        .map(n -> new PmsCycleActivationResponse.Notification(wire(n.getAudience()),
                                n.getSentCount(), wire(n.getStatus()), n.getSentOn()))
                        .toList();
        PmsCycleActivationResponse.Eligibility eligibility =
                eligibilityRunRepository.findFirstByCycleIdOrderByStartedOnDesc(cycle.getId())
                        .map(r -> new PmsCycleActivationResponse.Eligibility(wire(r.getStatus()), r.getStartedOn(),
                                r.getCompletedOn(), r.getTotalEligible(), r.getExcludedProbation(),
                                r.getExcludedNoticePeriod(), r.getExcludedMinService()))
                        .orElse(null);
        return new PmsCycleActivationResponse(toResponse(cycle), toDate(cycle.getPublishedOn()), notifications,
                eligibility);
    }

    private static Set<UUID> distinct(List<UUID> ids) {
        return ids == null ? Set.of() : new java.util.LinkedHashSet<>(new HashSet<>(ids));
    }

    private static String wire(Enum<?> value) {
        return value == null ? null : value.name().toLowerCase(Locale.ROOT);
    }

    private static LocalDate toDate(LocalDateTime value) {
        return value == null ? null : value.toLocalDate();
    }

    private static boolean flag(Boolean value) {
        return Boolean.TRUE.equals(value);
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String twoDigits(int year) {
        return String.format("%02d", year % 100);
    }
}
